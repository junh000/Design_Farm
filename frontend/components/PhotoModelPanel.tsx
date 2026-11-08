"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Box, ImagePlus, LoaderCircle } from "lucide-react";
import { api } from "./types";
import ArtworkImage from "./ArtworkImage";
import GeneratedModelPreview from "./GeneratedModelPreview";
import Modal from "./Modal";

type SourceImage = { id: string; url: string };
type GenerationConfig = {
  enabled: boolean; provider: string; min_images: number; max_images: number;
  max_image_bytes: number; reason: string | null;
};
type JobStatus = "queued" | "submitting" | "running" | "succeeded" | "failed" | "needs_review" | "adopted";
type GenerationJob = {
  id: string; status: JobStatus; progress: number; source_images: SourceImage[];
  candidate_url: string | null; model: SourceImage | null; error: string | null;
  can_retry: boolean; attempts: number; created: number; updated: number;
  consumed_credits: number | null;
};
const directions = ["정면", "오른쪽", "뒷면", "왼쪽"];
const statusLabel: Record<JobStatus, string> = {
  queued: "생성 대기", submitting: "사진 전달 중", running: "모형 생성 중",
  succeeded: "검토할 모형 도착", failed: "생성 실패", needs_review: "요청 확인 필요", adopted: "채택한 모형",
};
const isActive = (job: GenerationJob) => ["queued", "submitting", "running"].includes(job.status);
const message = (error: unknown) => error instanceof Error ? error.message : "잠시 후 다시 시도해 주세요.";

export default function PhotoModelPanel({ disabled, onAdopt, onBusyChange }: {
  disabled: boolean;
  onAdopt: (model: SourceImage & { name: string }) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [config, setConfig] = useState<GenerationConfig | null>(null);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [photos, setPhotos] = useState<(SourceImage | null)[]>([null, null, null, null]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const [consent, setConsent] = useState(false);
  const [retryConsent, setRetryConsent] = useState<Record<string, boolean>>({});
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [modelReady, setModelReady] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const requestKey = useRef<string | null>(null);
  const retryKeys = useRef<Record<string, { attempt: number; key: string }>>({});
  const pending = useRef(false);
  const loadingJobs = useRef(false);
  const refreshAgain = useRef(false);
  const mutationVersion = useRef(0);
  const alive = useRef(true);
  const waiting = jobs.some(isActive);
  const locked = disabled || busy || uploading !== null;
  const reviewJob = jobs.find((job) => job.id === reviewId);
  const reviewUrl = reviewJob?.candidate_url || reviewJob?.model?.url;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    onBusyChange(busy || uploading !== null);
    return () => onBusyChange(false);
  }, [busy, uploading, onBusyChange]);
  const loadJobs = useCallback(async () => {
    if (loadingJobs.current) { refreshAgain.current = true; return; }
    loadingJobs.current = true;
    try {
      do {
        refreshAgain.current = false;
        const version = mutationVersion.current;
        const result = await api<{ jobs: GenerationJob[] }>("/model-generations");
        if (alive.current && version === mutationVersion.current) setJobs(result.jobs);
        else if (alive.current) refreshAgain.current = true;
      } while (alive.current && refreshAgain.current);
    } finally { loadingJobs.current = false; }
  }, []);
  const load = useCallback(async () => {
    try {
      const result = await api<GenerationConfig>("/model-generation/config");
      if (alive.current) { setConfig(result); setError(""); }
      await loadJobs();
    } catch (cause) { if (alive.current) setError(message(cause)); }
  }, [loadJobs]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => { void loadJobs().catch((cause) => {
      if (alive.current) setError(message(cause));
    }); }, 4000);
    return () => clearInterval(timer);
  }, [waiting, loadJobs]);
  useEffect(() => { setModelReady(false); setReviewed(false); }, [reviewId, reviewUrl]);

  function remember(job: GenerationJob) {
    mutationVersion.current += 1;
    setJobs((current) => [job, ...current.filter((other) => other.id !== job.id)]);
  }
  async function upload(index: number, file: File | undefined) {
    if (!file || locked || pending.current || !config?.enabled) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > config.max_image_bytes) {
      setError("JPG, PNG, WEBP 사진을 한 장당 5MB 이하로 선택해 주세요."); return;
    }
    pending.current = true; setUploading(index); setError("");
    try {
      const body = new FormData(); body.append("file", file);
      const image = await api<SourceImage>("/uploads", { method: "POST", body });
      if (!alive.current) return;
      setPhotos((current) => current.map((value, i) => i === index ? image : value));
      requestKey.current = null; setConsent(false);
    } catch (cause) { if (alive.current) setError(message(cause)); }
    finally { pending.current = false; if (alive.current) setUploading(null); }
  }
  async function generate(retry?: GenerationJob) {
    if (locked || pending.current || !config?.enabled || waiting) return;
    if (retry ? !retryConsent[retry.id] || !retry.can_retry : !consent || photos.some((photo) => !photo)) return;
    pending.current = true; setBusy(true); setError("");
    mutationVersion.current += 1;
    try {
      if (retry && retryKeys.current[retry.id]?.attempt !== retry.attempts) {
        retryKeys.current[retry.id] = { attempt: retry.attempts, key: crypto.randomUUID() };
      }
      const key = retry
        ? retryKeys.current[retry.id].key
        : (requestKey.current ??= crypto.randomUUID());
      const result = await api<GenerationJob>(retry ? `/model-generations/${retry.id}/retry` : "/model-generations", {
        method: "POST", body: JSON.stringify({ request_key: key, consent: true,
          ...(!retry ? { source_image_ids: photos.map((photo) => photo!.id) } : {}),
        }),
      });
      if (!alive.current) return;
      remember(result);
      if (retry) { delete retryKeys.current[retry.id]; setRetryConsent((current) => ({ ...current, [retry.id]: false })); }
    } catch (cause) {
      if (alive.current) { setError(message(cause)); void loadJobs().catch(() => {}); }
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  async function adopt() {
    if (!reviewJob || !modelReady || !reviewed || locked || pending.current) return;
    pending.current = true; setBusy(true); setError("");
    mutationVersion.current += 1;
    try {
      const model = await api<SourceImage>(`/model-generations/${reviewJob.id}/adopt`, { method: "POST", body: "{}" });
      if (!alive.current) return;
      onAdopt({ ...model, name: "사진으로 만든 모형" });
      remember({ ...reviewJob, model, status: "adopted" });
      setReviewId(null);
    } catch (cause) { if (alive.current) setError(message(cause)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }

  return <details className="photo-model-panel">
    <summary><Box size={18} /><span>사진으로 3D 모형 만들기</span><small>{config?.enabled ? "실험 기능" : "연동 준비 중"}</small></summary>
    <div className="photo-model-content">
      <p>같은 작품을 한 바퀴 돌아 촬영한 사진 4장으로 모형을 만듭니다. 생성 결과를 원본과 비교하고 직접 채택한 모형만 작품에 첨부됩니다.</p>
      <p className="fine-print">정면부터 오른쪽·뒷면·왼쪽 순서로, 작품 전체가 보이게 촬영해 주세요. 현재 연동은 4장만 사용합니다. 반사·투명 재질이나 보이지 않는 부분은 정확히 복원되지 않을 수 있어요.</p>
      {!config?.enabled && <div className="inline-message" role="status">
        {config ? "사진→3D 생성은 아직 연동 준비 중이에요. 지금은 외부 사진 전송이나 생성 과금이 발생하지 않습니다. 기존 GLB 첨부와 사진만으로 작품 등록은 사용할 수 있어요." : "생성 기능 상태를 확인하고 있어요…"}
      </div>}
      <div className="generation-photos">
        {directions.map((direction, index) => <label className="generation-photo" key={direction}>
          <span>{index + 1}. {direction}</span>
          {photos[index] ? <ArtworkImage src={photos[index]!.url} alt={`${direction} 생성 원본 사진`} /> : <ImagePlus size={28} aria-hidden="true" />}
          <input type="file" aria-label={`${direction} 생성 사진`} accept="image/jpeg,image/png,image/webp"
            disabled={locked || !config?.enabled || waiting} onChange={(event) => { void upload(index, event.target.files?.[0]); event.target.value = ""; }} />
          <small>{uploading === index ? "업로드 중…" : "사진 선택 · 최대 5MB"}</small>
        </label>)}
      </div>
      <label className="checkbox"><input type="checkbox" checked={consent} disabled={locked || !config?.enabled || waiting}
        onChange={(event) => setConsent(event.target.checked)} />선택한 사진 4장을 Meshy에 전송하고 유료 생성을 요청하는 데 동의합니다.</label>
      <div className="generation-actions">
        <button type="button" className="button secondary" disabled={locked || !config?.enabled || waiting || !consent || photos.some((photo) => !photo)} onClick={() => void generate()}>
          {busy ? <LoaderCircle size={17} aria-hidden="true" /> : <Box size={17} aria-hidden="true" />}4장으로 모형 생성
        </button>
        <button type="button" className="text-link" disabled={locked} onClick={() => void load()}>상태 새로고침</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {jobs.length > 0 && <div className="generation-jobs"><h3>내 생성 작업</h3>
        <p className="fine-print">생성 대기 중이거나 실패해도 사진만으로 작품을 등록할 수 있어요. 완료된 모형은 이 목록에서 다시 확인할 수 있습니다.</p>
        {jobs.map((job) => <article className="generation-job" key={job.id}>
          <div className="generation-job-heading"><strong>{statusLabel[job.status]}</strong><small>{new Date(job.created).toLocaleString("ko-KR")}</small></div>
          {isActive(job) && <div role="status"><progress max={100} value={job.progress} aria-label="모형 생성 진행률" /><span>{job.progress}%</span></div>}
          {job.error && <p>{job.error}</p>}
          {job.status === "needs_review" && <p className="fine-print">전송 결과를 확인해야 해요. 중복 요청을 막기 위해 자동 재시도하지 않습니다. 운영자에게 확인을 요청해 주세요.</p>}
          {job.consumed_credits !== null && <p className="fine-print">이번 생성 사용량: {job.consumed_credits} 크레딧</p>}
          {(job.candidate_url || job.model?.url) && <button type="button" className="button secondary" disabled={locked}
            onClick={() => setReviewId(job.id)}>원본과 모형 비교하기</button>}
          {job.can_retry && <div className="generation-retry">
            <label className="checkbox"><input type="checkbox" checked={!!retryConsent[job.id]} disabled={locked || !config?.enabled || waiting}
              onChange={(event) => setRetryConsent((current) => ({ ...current, [job.id]: event.target.checked }))} />같은 사진으로 새 유료 생성 요청을 보내는 데 동의합니다.</label>
            <button type="button" className="button secondary" disabled={locked || !config?.enabled || waiting || !retryConsent[job.id]} onClick={() => void generate(job)}>다시 생성</button>
          </div>}
        </article>)}
      </div>}
    </div>
    {reviewJob && reviewUrl && <Modal title="원본 사진과 생성 모형 비교" wide onClose={() => { if (!pending.current) setReviewId(null); }}>
      <div className="registration-review">
        <p>아직 작품에 첨부하지 않았어요. 모든 방향에서 형태·재질·누락된 부분을 확인해 주세요.</p>
        <div className="generation-sources">{reviewJob.source_images.map((source, index) => <figure key={source.id}>
          <ArtworkImage src={source.url} alt={`${directions[index] || index + 1} 원본 사진`} /><figcaption>{directions[index] || index + 1}</figcaption>
        </figure>)}</div>
        <GeneratedModelPreview url={reviewUrl} onReady={setModelReady} />
        <label className="checkbox"><input type="checkbox" checked={reviewed} disabled={!modelReady || locked}
          onChange={(event) => setReviewed(event.target.checked)} />원본 사진과 비교해 모형의 형태·재질과 누락 부위를 확인했습니다.</label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="preview-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={() => setReviewId(null)}>채택하지 않고 닫기</button>
          <button type="button" className="button dark" disabled={locked || !reviewed || !modelReady} onClick={() => void adopt()}>{busy ? "첨부 중…" : "이 모형을 작품에 첨부"}</button>
        </div>
        <p className="fine-print">첨부 후에도 등록 전 미리보기에서 확인하고 최종 공개해야 구매자에게 표시됩니다.</p>
      </div>
    </Modal>}
  </details>;
}
