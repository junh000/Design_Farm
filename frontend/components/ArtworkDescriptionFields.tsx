"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { api } from "./types";

function artworkInput(form: HTMLFormElement, intent: string) {
  const data = new FormData(form);
  const category = data.get("category");
  return JSON.stringify({
    title: String(data.get("title") ?? "").trim(),
    category,
    material: String(data.get("material") ?? "").trim(),
    width: Number(data.get("width")),
    height: Number(data.get("height")),
    depth: category === "디지털" ? 0 : Number(data.get("depth")),
    intent: intent.trim(),
  });
}

export default function ArtworkDescriptionFields() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [intent, setIntent] = useState("");
  const intentField = useRef<HTMLTextAreaElement>(null);
  const storyField = useRef<HTMLTextAreaElement>(null);
  const [story, setStory] = useState("");
  const [draft, setDraft] = useState<{ text: string; input: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const requesting = useRef(false);

  useEffect(() => {
    const request = new AbortController();
    void api<{ enabled: boolean }>("/artwork-descriptions/config", { signal: request.signal })
      .then(({ enabled }) => {
        if (!request.signal.aborted) setAvailable(enabled);
      })
      .catch(() => {
        if (!request.signal.aborted) setAvailable(false);
      });
    return () => request.abort();
  }, []);

  async function generate(form: HTMLFormElement | null) {
    if (!form || !available || requesting.current) return;
    setError("");
    const fields = ["title", "material", "width", "height"];
    if (new FormData(form).get("category") !== "디지털") fields.push("depth");
    for (const name of fields) {
      const field = form.elements.namedItem(name) as HTMLInputElement;
      if (!field.reportValidity()) return;
      if (!field.value.trim() && field.required) {
        field.focus();
        setError("작품명, 재료와 치수를 입력해 주세요.");
        return;
      }
    }
    const input = artworkInput(form, intent);
    requesting.current = true;
    setBusy(true);
    setDraft(null);
    try {
      const { description } = await api<{ description: string }>("/artwork-descriptions", {
        method: "POST",
        body: input,
      });
      setDraft({ text: description, input });
    } catch (error) {
      setError(error instanceof Error ? error.message : "다시 시도해 주세요.");
    } finally {
      requesting.current = false;
      setBusy(false);
    }
  }

  function applyDraft() {
    const field = storyField.current;
    if (!field?.form || !draft) return;
    if (artworkInput(field.form, intentField.current?.value ?? "") !== draft.input) {
      setError("작품 정보가 바뀌었어요. 현재 정보로 초안을 다시 생성해 주세요.");
      setDraft(null);
      return;
    }
    setStory(draft.text);
    setDraft(null);
    setError("");
    field.focus();
  }

  return (
    <>
      <div className="artwork-description-assist" aria-label="AI 작품 설명 작성 도움">
        <h3><Sparkles size={16} aria-hidden="true" /> AI 작품 설명 초안</h3>
        {available ? (
          <>
            <label>
              제작 의도 (선택 · 초안에만 사용)
              <textarea ref={intentField} value={intent} onChange={(event) => setIntent(event.target.value)}
                rows={3} maxLength={360} placeholder="예: 반복되는 선으로 늦여름의 고요함을 표현했어요." />
            </label>
            <p id="ai-description-note" className="fine-print">
              생성할 때 작품명·분류·재료·치수·제작 의도를 OpenAI에 보냅니다. 입력란에 개인정보를 적지 마세요.
            </p>
            <button type="button" className="button secondary" disabled={busy} aria-describedby="ai-description-note"
              onClick={(event) => void generate(event.currentTarget.form)}>
              {busy ? "초안 작성 중…" : error || draft ? "초안 다시 생성" : "AI 초안 생성"}
            </button>
          </>
        ) : (
          <p className="fine-print" role="status">
            {available === null ? "AI 초안 기능을 확인하고 있어요." : "AI 초안은 준비 중이에요. 아래에 설명을 직접 작성할 수 있어요."}
          </p>
        )}
        {busy && <p className="fine-print" role="status">초안을 기다리는 동안 설명을 직접 작성할 수 있어요.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {draft && (
          <div className="artwork-description-draft" role="region" aria-label="생성된 초안">
            <p className="fine-print" role="status">초안이 준비됐어요. 내용이 작품과 일치하는지 확인해 주세요.</p>
            <p>{draft.text}</p>
            <button type="button" className="button secondary" onClick={applyDraft}>
              {story.trim() ? "기존 설명을 초안으로 바꾸기" : "작품 설명에 적용"}
            </button>
          </div>
        )}
      </div>
      <label>
        작품 설명
        <textarea ref={storyField} name="story" required maxLength={500} rows={4} value={story}
          onChange={(event) => setStory(event.target.value)} placeholder="구매자에게 공개할 작품 설명을 작성해 주세요." />
      </label>
    </>
  );
}
