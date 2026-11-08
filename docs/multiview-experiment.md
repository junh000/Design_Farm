# 다각도 사진 → 3D 생성 실험 (#6)

## 현재 결과

**실물 작품의 생성 품질은 아직 검증하지 않았다.** 2026-11-08 현재 같은 작품을 촬영한 사진 세트와 생성 API 키가 제공되지 않았고, 비용 없이 연동 준비까지 진행하기로 했다. 외부 생성 요청은 실행하지 않았다. 단위 검사에서 사용하는 색상 이미지와 삼각형 GLB는 통신·검증 절차용 fixture이며 실물 생성 결과가 아니다.

| 확인 항목 | 현재 상태 |
| --- | --- |
| 동일 실물의 4방향 및 추가 각도 사진 | 미제공 |
| 실제 생성 GLB / 형태·재질·누락 비교 | 미실시 |
| 실제 생성 시간 / 사용 크레딧 | 측정 전 |
| 작가에게 공개 가능한 품질 | 판단 보류 |
| 로컬 사진 준비, 메타데이터 제거, 실행 기록 | 구현 |
| 명시적 동의 후 요청, 중복 실행 방지, 기존 작업 조회 | 구현·오프라인 검사 |

위의 실제 검증 항목을 채우기 전에는 #6을 완료로 표시하거나 웹에서 생성 품질이 검증됐다고 안내하지 않는다. #7의 연동은 별도 활성화 설정과 키가 준비될 때까지 대기 상태로 둔다.

## 생성 방식과 한도

현재 어댑터는 Meshy Multi-Image to 3D의 `meshy-7.1`을 고정 사용한다. 이 엔진은 한 번에 **최대 4장**을 받는다. 첫 사진은 정면이다. 도구는 네 방향을 정확히 네 장 입력받고, 추가 각도 사진은 모델 비교용으로 보존한다. 8장 전체를 사용했다고 표시하거나 몰래 네 장으로 잘라 보내지 않는다. 추가 각도의 효과를 비교하려면 같은 작품에서 다른 네 장을 선택한 별도 실행을 만들고 각각의 비용·결과를 기록한다. [공식 API](https://docs.meshy.ai/en/api/multi-image-to-3d)

표준 해상도, 텍스처, 삼각형 리메시 30,000면 목표를 사용한다. 실제 치수는 작가가 측정해 기록하며 AI의 크기 추정은 끈다. 생성 성공과 판매 가능한 품질은 구분한다. [모델 선택 안내](https://docs.meshy.ai/en/api/models)

문서 확인일 기준 텍스처 포함 표준 생성의 예상 사용량은 **30크레딧/요청**이다. 이 숫자는 서버가 강제하는 결제 상한이 아니다. 실행 직전 제공사 요금과 계정 지출 제한을 확인해야 한다. 실제 값은 응답의 `consumed_credits`를 기록하며, 원화·달러 비용은 구매한 요금제 근거 없이는 계산하지 않는다. 무료 플랜의 API 생성은 허용되지 않을 수 있다. [API 가격](https://docs.meshy.ai/en/api/pricing), [API 요청 조건](https://docs.meshy.ai/en/api/multi-image-to-3d)

## 실험 준비 — 네트워크 사용 없음

1. 동일 작품을 고정해 정면·오른쪽·뒷면·왼쪽을 촬영하고, 사선 4장을 추가한다. 작품 전체가 보이도록 하고 조명·배경·거리 차이를 기록한다. 반사·투명·얇은 부품·빈 공간은 별도 비교 대상으로 적는다.
2. 사진과 측정 치수, 사용 권한, 촬영 조건을 `experiments/multiview-manifest.example.json` 형식으로 기록한다. 파일을 `output/multiview/<작품>/` 아래 복사해 사용하면 사진·키·결과를 Git에 올리지 않을 수 있다.
3. 확인 후 `same_object_confirmed`, `rights_confirmed`를 `true`로 바꾼다. 사진은 장당 5MB, 32px 이상, 1,600만 화소 이하의 JPG/PNG/WEBP여야 한다. 준비 단계에서 방향을 보정하고 EXIF 등 촬영 메타데이터를 제거한다. 실제 전송할 정규화 파일의 해시도 남긴다.

저장소 루트에서:

```powershell
backend/.venv/Scripts/python.exe experiments/multiview.py prepare output/multiview/vase/manifest.json output/multiview/vase/run-a
```

결과의 `report.json`에는 입력 수·사진별 역할·해시·옵션·예상 크레딧과 미검증 상태만 기록된다. 원본 파일을 덮어쓰지 않는다. 별도 네트워크 호출은 없다.

## 실제 생성 — 키와 비용 승인이 준비된 경우에만

API 키는 운영자의 환경 변수 `DESIGN_FARM_MESHY_API_KEY`로 제공한다. 키를 명령 인자, manifest, Git 또는 보고서에 적지 않는다. 다음 명령은 네 장의 정규화 사진을 Meshy에 전송하고 유료 생성 한 건을 요청하므로, 현재 준비 작업에서는 실행하지 않았다.

```powershell
backend/.venv/Scripts/python.exe experiments/multiview.py submit output/multiview/vase/run-a --confirm-photo-transfer --approve-estimated-credits 30
backend/.venv/Scripts/python.exe experiments/multiview.py poll output/multiview/vase/run-a
```

`poll`은 기존 작업을 한 번 조회한다. 제공사의 `Retry-After`가 적용되는 간격보다 빠르게 반복하지 말고, 일반적으로 최소 15초 간격을 둔다. 조회를 멈춰도 생성이 취소되거나 환불되는 것은 아니다. [요청 제한](https://docs.meshy.ai/en/api/rate-limits)

동일 실행 폴더에 `submit`을 다시 실행하면 거부한다. 생성 요청 도중 응답이 끊기면 `submission_unknown`으로 남기며 자동 재요청하지 않는다. 이 경우 제공사 대시보드에서 과금·작업 생성 여부를 확인한 뒤 운영자가 기존 작업 ID를 복구해야 한다. `.operation.lock`이 남으면 먼저 다른 실행이 없는지와 보고서 상태를 확인해야 한다. 폴더를 새로 만들어 다시 제출하는 것은 새 과금 요청이다.

다운로드는 `assets.meshy.ai`의 HTTPS 주소만 허용하고 리디렉션·비공개 IP를 거절한다. 다운로드에 API 키를 보내지 않으며, 만료 토큰이 포함된 결과 URL도 보고서에 저장하지 않는다. 20MB와 앱의 GLB 검사를 통과한 파일만 `result.glb`로 남긴다. 제공사 생성이 성공해도 앱이 지원하지 않는 압축 GLB나 외부 리소스 참조는 거절한다.

## 비교와 공개 판단

생성 파일을 사이트의 작품 등록 미리보기나 GLB 뷰어에서 열고 360°로 확인한다. 네 입력 사진과 추가 각도를 모두 비교해 다음 내용을 기록한다.

| 평가 | 남길 근거 |
| --- | --- |
| 형태 | 앞·뒤 실루엣, 비례, 구멍·손잡이·얇은 부품, 바닥의 변형 |
| 재질 | 색, 표면 무늬, 광택, 질감, 사진 배경의 혼입 |
| 누락·생성 오류 | 가려진 부분의 임의 생성, 붙은 부품, 떠 있는 면·뭉개짐 |
| 시간·비용 | 보고서의 실제 생성 초·사용 크레딧, 금액은 요금제 근거가 있을 때만 |
| 공개 판단 | 채택/거절, 이유, 사용한 GLB 해시와 비교 화면 파일 경로 |

`experiments/multiview-review.example.json`을 복사해 실제 관찰 결과를 적고:

```powershell
backend/.venv/Scripts/python.exe experiments/multiview.py review output/multiview/vase/run-a output/multiview/vase/review.json
```

검토 명령은 보고서만 갱신한다. 자동으로 웹사이트에 게시하거나 작품을 생성하지 않는다. 형태·재질·누락 설명과 모든 사진 비교 확인이 없으면 채택 기록을 거절한다. 입력 치수로 모형을 맞췄다는 이유만으로 AR 실측 정확도를 입증할 수는 없다.

## 오프라인 검사

```powershell
backend/.venv/Scripts/python.exe -m unittest experiments.test_multiview -v
```

네트워크 없이 입력 수·중복 사진·메타데이터 제거·유료 요청 동의·불확실 요청의 재생성 차단·사용량 기록·GLB 거절·개인 주소 다운로드 차단·사람의 검토 요건을 검사한다. 이 결과는 실제 생성 품질 평가를 대체하지 않는다.
