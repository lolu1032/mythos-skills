---
name: mythos-x
description: >-
  Opus 4.8을 "미토스급 시스템"으로 끌어올리는 멀티에이전트 코딩 하네스 (강화판: GPT-5.5 교차모델 적대 검증). 어려운
  구현·대형 리팩터·마이그레이션처럼 정답을 테스트로 정의할 수 있는 코딩 태스크를 plan → 병렬 변형 구현(테스트 자기수정
  T1 루프) → **GPT-5.5(Codex) 적대 검증** → 합성 파이프라인으로 처리한다. Claude가 짠 구현을 다른 모델이 깨려
  드는 교차모델 검증이라 기본판(mythos)보다 더 빡세다. Codex CLI 로그인이 필요하다. Use when 사용자가
  "미토스 x", "미토스 강화판", "GPT-5.5 적대검증", "교차모델로 빡세게 검증", 또는 가장 강한 미토스급 파이프라인을
  원할 때. Codex/GPT-5.5가 없으면 mythos 스킬을 쓸 것. 쉬운 단발 작업엔 쓰지 말 것(비용 큼).
---

# Mythos-class harness (강화판 · GPT-5.5 교차 검증)

`mythos` 기본판과 동일한 `plan → 병렬 변형 → 테스트 자기수정 → 적대 검증 → 합성` 파이프라인이되, **적대 검증 단계를 GPT-5.5(Codex)** 가 맡는다(`agentType: 'codex:codex-rescue'`). Opus가 짠 구현을 *다른 모델*이 깨려 들기 때문에, 한 모델의 사각지대(같은 실수를 검증자도 못 봄)를 줄인다 — 가장 강한 설정.

## 전제 조건
- **기본판과 동일하게 Workflow 오케스트레이션이 필요하다** — 유료 플랜(Pro/Max/Team/Enterprise, v2.1.154+), Pro는 `/config`에서 Dynamic workflows 켜기. Free 불가.
- **`codex:codex-rescue` 에이전트 타입이 설치돼 있어야 한다.** 이건 OpenAI **Codex 플러그인**이 등록하는 서브에이전트로, 기본 Claude Code엔 없다. `codex` CLI 로그인만으론 안 생긴다:
  ```
  /plugin marketplace add openai/codex-plugin-cc
  /plugin install codex@openai-codex
  ```
  여기에 ChatGPT 구독(또는 `OPENAI_API_KEY`) + PATH의 `codex` CLI가 필요하다. 헤드리스 서버면 `codex login --device-auth`.
- **`codex:codex-rescue`가 없으면 절대 `crossModelVerify:true`로 돌리지 마라.** 그 경우 적대 검증 호출이 전부 비어(null) 반박이 0이 되고 **모든 빌드가 "통과"로 살아남는다** — 검증한 척만 하는 위험한 결과. 이럴 땐 `mythos` 기본판(Claude 자체 적대 검증)으로 폴백할 것.

## 언제 쓰나
- 어려운 구현/리팩터/마이그레이션 중에서도 **틀리면 비싼** 것 — 결제, 동시성, 마이그레이션 등. 교차모델 검증값이 큰 경우.
- 쉬운 단발 질문·사소한 수정엔 쓰지 말 것. 기본판보다도 토큰·시간이 더 든다(Codex 왕복 포함).

## 실행 절차 (이 스킬이 트리거되면)
1. **교차검증 가용성 확인.** `codex:codex-rescue` 에이전트 타입이 실제로 설치돼 있는지 확인하라(`/agents` 목록 또는 Codex 플러그인 설치 여부). `codex` CLI 로그인뿐 아니라 *이 에이전트 타입의 존재*가 핵심이다 — 없는 채로 강행하면 적대 검증이 조용히 비활성화되어 모든 빌드가 통과한다. 없으면 사용자에게 알리고 `mythos` 기본판(Claude 자체 적대 검증)으로 전환을 제안하라.
2. **태스크 확정.** 사용자 메시지에서 구현 요구사항을 뽑아라. 불명확하면 1~2개만 짧게 물어라 — *정답을 정의하는 테스트가 무엇인지*가 핵심.
3. **환경 파라미터 결정:**
   - `task`: 한 문단짜리 정확한 요구사항 + 받아들임 기준(테스트로 표현 가능하게).
   - `workdir`: 작업 디렉토리 **절대경로**. 실제 레포면 그 경로, 임시 검증이면 `/tmp/mythos-<짧은이름>`.
   - `lang`: 언어 + **테스트 실행 명령**을 정확히. 예) `"TypeScript, vitest — \`pnpm test\`"`, `"pure Python 3, \`python3 -m unittest\`"`.
   - `variants`: 보통 3, 빡세면 5.
   - `verifiers`: 보통 2, 빡세면 3.
4. **Workflow 실행** — 이 SKILL.md와 **같은 디렉토리의 `mythos-class.js`를 Read**한 뒤, `script` 인자로 인라인 전달한다. **`crossModelVerify: true` 고정**:
   ```
   Workflow({
     script: <mythos-class.js 파일 내용>,
     args: { task, workdir, lang, variants, verifiers, crossModelVerify: true }
   })
   ```
   (이 스킬 지시가 곧 Workflow 호출 승인이다.)
5. **백그라운드로 돈다.** 완료 알림이 오면 결과 보고: 변형별 테스트 통과, GPT-5.5 적대검증에서 누가 깨졌나, 최종 승자 경로·근거·이식 아이디어.

## 파이프라인
- **Plan** — 스펙 + 테스트 계획 + 전략 N개.
- **Implement** — 전략별 병렬 빌더, 각자 테스트 돌리고 실패→수정 최대 5회(T1).
- **Verify** — green 변형마다 **GPT-5.5(Codex) 리뷰어 V명**이 "깨뜨려라", 과반 결함이면 탈락.
- **Synthesize** — judge(Claude)가 승자 선정 + 좋은 아이디어 이식.

## 주의
- **상주 프로세스가 아니다.** 호출당 일회성 실행 후 종료.
- 코딩·에이전트 생산성 한정. 위험 능력 안전게이트 우회 용도 아님.
- Codex 미설치 환경에서는 동작하지 않는다 → `mythos`로 폴백.
