# LearnOS AI — Development Instructions. 

## Project
LearnOS AI is a personalized learning operating system.

## Source of Truth
Read `docs/MASTER_SPEC.md` before making architectural or feature decisions.

## Architecture
- Frontend: Next.js + React + TypeScript
- Backend: Python + FastAPI
- Auth: Firebase Authentication
- Database: Firestore
- Storage: Google Cloud Storage
- AI: Gemini / Google AI
- Live Tutor: Gemini Live API
- Deployment: Google Cloud Run

## Development Rules
- Build incrementally.
- Do not generate the entire application at once.
- Complete and test one feature before starting the next.
- Prefer a modular monolith over unnecessary microservices.
- Keep business logic in the backend.
- Never expose private API keys in frontend code.
- AI output must be validated before changing application state.
- Firestore is the source of truth for learner state.
- Do not hardcode the learning curriculum as the permanent source of truth.
- Keep model IDs configurable.
- Keep expensive image/video/avatar capabilities feature-flagged.
- Preserve existing working functionality when adding features.

## Workflow
1. Inspect the existing code.
2. Read the relevant specification.
3. Explain the small change being made.
4. Implement only that change.
5. Run tests/type checks/lint where applicable.
6. Fix errors.
7. Report what changed.
8. Wait for the next instruction.

## Important
Do not make large architectural changes without explicit approval.