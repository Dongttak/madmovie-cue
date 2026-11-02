# CUE 알파 기여 안내

## 작업 기록

GitHub Issues를 할 일·버그·편집 품질의 기준으로 사용합니다. Discord에서 논의하더라도
결정·완료 기준·관련 PR은 이슈에 요약합니다. Jira·Linear·별도 문서 도구는 현재 도입하지 않습니다.

권장 라벨은 `bug`, `editing-quality`, `enhancement`, `documentation`, `good first issue`입니다.
상태는 우선 열린 이슈 / PR 진행 / 닫힌 이슈로 관리합니다. 규모가 커지면 GitHub Projects를 검토합니다.

편집 품질 이슈에는 문제 시점, 기대하는 변화, 원속도와의 차이, 계획 JSON을 남깁니다.
청감으로 확인한 내용과 영상 프레임·수치로만 확인한 내용을 구분합니다.

## 브랜치와 PR

현재는 소규모 알파이므로 [GitHub flow](https://docs.github.com/en/get-started/using-github/github-flow)를 사용합니다.

- `main`: 검증한 통합 기준. 배포 시점은 수동 선택하며 태그로 기록합니다.
- `feature/<issue>-<topic>`, `fix/<issue>-<topic>`, `docs/<topic>`: 짧은 작업 브랜치.
- `hotfix/<topic>`: 배포한 버전 또는 main 기준 수정 후 PR로 통합.
- `release/<version>`: 실제 QA 동결 기간이 필요할 때만 만들고 검증 후 삭제.

상시 `develop`과 `release`를 함께 유지하지 않습니다. 병렬 QA와 다음 버전 개발이 반복돼
별도 통합 브랜치가 필요해질 때 재검토합니다. 하나의 이슈·PR에는 검토 가능한 한 가지 변경을 담습니다.
가능하면 squash merge하고 작업 브랜치를 삭제합니다. 태그 예시는 `v0.10.1-alpha.1`이며 아직 발행하지 않았습니다.

실제 저장소 생성 후 main의 직접 푸시·강제 푸시·삭제를 제한하고 PR 경로를 사용합니다.
협업자가 생기면 리뷰 1명 이상을 권장합니다. CI가 없는 동안 존재하지 않는 상태 검사를 필수로 설정하지 않습니다.
저장소 보호 정책은 현재 로컬에서 설정한 것이 아니라 원격 저장소 설정 시 적용할 항목입니다.

## 수동 검증

```bash
npm ci
npm run verify
npm run test:public
npm run test:security
```

서버 / 렌더 변경은 FFmpeg·FFprobe 설치 후 `npm run test:server`, UI 변경은
`npx playwright test`를 추가합니다. 파형·타이밍 로직은 기존 단위 테스트로 확인하고,
영상 효과는 같은 소스의 원속도 버전과 비교합니다. 소소한 문서 변경 때문에 전체 렌더를 반복하지 않습니다.
Git에 스테이징한 후 `npm run check:public`을 실행하고 PR에 확인 명령·결과·남은 한계를 적습니다.
자동 CI/CD는 아직 없습니다. 프로덕션 자격 증명은 소스·테스트·PR에 넣지 않습니다.

## Discord 운영안

서버가 개설되면 최소 채널로 시작합니다.

- `#announcements`: 사람이 확인한 알파 릴리스·중요 공지
- `#feedback`: 사용 경험·편집 비교와 GitHub 이슈 링크
- `#development`: 개발 논의, 이슈·PR 알림

Discord의 GitHub 알림 연동은 `#development`에 이슈·PR·릴리스 이벤트만 보내도록 설정합니다.
이는 CI/CD와 별개입니다. 전체 커밋·댓글 이벤트는 초기에 켜지 않습니다.
Webhook 관리는 신뢰하는 관리자에게만 허용하고 멘션·외부 앱 권한도 필요한 범위로 제한합니다.
Webhook URL은 비밀값이며 이슈·브라우저 코드·문서에 적지 않습니다.
앱의 Discord 알림 전송 코드나 실제 Webhook은 아직 연결하지 않았습니다.

## 미디어와 라이선스

자체 제작·사용 허가가 확인된 자료만 공개 예제에 사용합니다.
선수 방송·대회 영상·레퍼런스·상용 음악·그 음악이 들어간 결과물은 공개 저장소에 넣지 않습니다.
`materials/`와 로컬 공급 카탈로그는 제외합니다. `.gitignore`가 권리 확인을 대신하지는 않습니다.
허가가 불명확한 자료는 외부 원본 링크와 시점으로 설명하세요.

CUE 작성 코드에 대한 기여는 MIT 라이선스로 제공할 권한이 있어야 합니다.
외부 코드·에셋은 출처와 라이선스를 명시하고 [고지](THIRD_PARTY_NOTICES.md)를 갱신합니다.
의존성은 실제 기능·검증에서 필요한 경우에만 추가하고 잠금 파일을 함께 갱신합니다.
npm의 `private: true`는 실수로 npm 레지스트리에 게시하는 것을 막기 위한 것으로 GitHub 공개 여부와는 별개입니다.
