# LearnOS AI — Master Product Specification

## 1. Product Identity

LearnOS AI is an AI learning operating system that builds and continuously adapts a personalized mastery journey for any learning goal.

Core principle:

> LearnOS does not simply personalize content. It personalizes the learner's path to mastery.

LearnOS is not a generic chatbot, static LMS, fixed course platform, simple RAG application, course marketplace, or basic quiz generator.

The system continuously understands:
- the learner
- knowledge required for the goal
- evidence of understanding
- what the learner should do next

## 2. Core Learning Loop

```text
Goal → Discover → Diagnose → Map → Learn → Practice → Prove → Remember → Adapt → Repeat
```

Learning evidence must continuously influence the learner's next action.

## 3. MVP User Journey

The first working end-to-end journey is:

```text
Landing
→ Sign Up / Sign In
→ Onboarding
→ Learning Goal
→ AI Syllabus
→ Diagnostic
→ Personalized Plan
→ Student Dashboard
→ Learning Session
→ AI Tutor
→ Practice
→ Progress / Mastery
→ Personalized Next Action
```

Authentication uses Firebase Authentication with:
- Email/password signup
- Email/password login
- Logout
- Persistent authenticated session

The backend must validate authenticated users before accessing private learner data.

## 4. Learner Onboarding

After first login collect a short profile:
- learning goal
- target outcome
- current level
- optional exam/certification
- available study time
- optional deadline
- optional preferred learning time
- useful learning preferences

Keep onboarding short and adaptive.

## 5. Universal Learning Goal

The learner can describe a goal naturally.

Example:

> I want to become an AI engineer in six months.

The system converts the goal into structured learning requirements. Goals must not be restricted to predefined courses.

## 6. AI Syllabus / Curriculum Agent

The AI must dynamically create a syllabus instead of using a permanently hardcoded curriculum.

For a goal, the agent should:

1. Understand the learner's desired outcome.
2. Identify the relevant official platform, exam, certification, documentation, standard, or authoritative source when applicable.
3. Research current authoritative requirements when external research is needed.
4. Convert requirements into structured stages, topics, concepts, objectives, difficulty, effort, and prerequisites.
5. Create concept relationships such as:
   - prerequisite_of
   - related_to
   - part_of
   - extends
   - assessment_for
6. Validate the generated structure.
7. Store the structured curriculum in Firestore.
8. Use the stored curriculum as the source for the dashboard and learning experience.
9. Recalculate/update it only when required.

Resource metadata should include:
- title
- URL
- publisher
- source type
- retrieved time
- relevance
- reason for recommendation

Never fabricate resource URLs.

## 7. Diagnostic Assessment

Before finalizing a personalized path, assess the learner.

Initial diagnostic: approximately 5–10 questions.

Identify:
- strengths
- weaknesses
- prerequisite gaps
- current knowledge
- confidence signals
- recommended starting point

Questions should become adaptive where practical.

Course completion alone must not be treated as proof of mastery.

## 8. Personalized Learning Plan

Generate the plan using:

```text
Goal
+ Learner Profile
+ Diagnostic Evidence
+ Required Knowledge
+ Prerequisites
+ Available Time
+ Deadline
+ Relevant Resources
```

Plan contains:
- stages
- topics
- concepts
- prerequisites
- estimated effort
- difficulty
- learning objectives
- practice requirements
- assessment requirements

The learner can edit the plan.

## 9. Knowledge Graph

Represent curriculum concepts as structured graph data.

Example:

```text
Python Basics
→ Variables
→ Conditions
→ Loops
→ Functions
→ Data Structures
→ OOP
```

The graph must support personalized progression.

AI-generated curriculum must be validated and stored as structured data.

## 10. Student Dashboard

The dashboard must be actionable, not just a collection of statistics.

Display:
- current learning goal
- continue learning
- current concept
- curriculum/progress
- mastery overview
- weak concepts
- recent activity
- today's recommendation
- next best action
- learning tracks

Dashboard reads persisted state. It must not regenerate the entire curriculum on every visit.

## 11. Learning Session

A learning session should show:
- current concept
- lesson/content
- examples
- exercises
- progress
- AI Tutor

Preferred desktop experience:

```text
Left: Learning Path / Curriculum
Center: Lesson / Practice
Right: AI Tutor / Notes / Insights
```

Keep the UI professional, clear, original, and responsive.

## 12. AI Tutor

The AI Tutor must be context-aware.

When relevant it should know:
- current track
- stage
- concept
- prerequisites
- mastery
- misconceptions
- previous attempts
- relevant notes/resources
- recent conversation

Modes:
- Explain
- Practice
- Hint
- Socratic
- Exam
- Simplify
- Challenge
- Teach-back

Tutor should:
- explain
- ask questions
- provide examples/counterexamples
- detect misconceptions
- give hints
- adapt difficulty
- check understanding
- recommend next actions

Prefer guided learning instead of immediately giving answers.

Future live tutor may support voice input/output, conversational tutoring, and avatar/visual output. Voice and avatar must be feature-flagged and must not be required for the core application.

## 13. Practice Engine

Practice adapts to:
- current concept
- mastery
- previous mistakes
- difficulty
- misconceptions
- learner goal

Initial question types:
- multiple choice
- true/false
- short answer
- numerical answer
- coding questions where applicable

Wrong answer:

```text
Wrong
→ Diagnose likely error
→ Hint
→ Explanation
→ Retry
→ Update evidence
```

Correct answer:

```text
Correct
→ Explanation
→ Mastery evidence
→ Next appropriate question
```

## 14. Misconception and Mastery

Detect conceptual misconceptions, not only wrong answers.

For a detected misconception:
1. identify likely misconception
2. explain the correct mental model
3. provide targeted practice
4. retest
5. update learner state

Store misconception evidence.

Mastery signals may include:
- correctness
- attempts
- difficulty
- confidence
- explanation quality
- teach-back quality
- repeated mistakes
- misconception signals

Mastery states:

```text
not_started
needs_foundation
learning
developing
strong
mastered
```

These are application heuristics, not scientifically validated measurements.

## 15. Learner State and Progress

Firestore is the source of truth for learner state.

Track at minimum:
- user profile
- learning goals/tracks
- curriculum
- current concept
- completed concepts
- concept mastery
- diagnostic results
- practice attempts
- misconceptions
- learning sessions
- recent activity
- next recommendation

Each user must have isolated learner data.

## 16. Memory and Context

Separate memory into:
- working/session memory
- course memory
- learner memory
- knowledge memory

The Context Engine retrieves only relevant context for an AI request:
- current concept
- prerequisites
- mastery
- recent mistakes
- relevant notes/resources
- recent conversation

Do not send the learner's complete history to Gemini on every request.

Gemini is intelligence, not persistent memory.

## 17. Notes

The system should eventually generate:
- Full Notes
- Quick Revision
- Weak Areas

Notes can contain:
- summaries
- definitions
- mental models
- examples
- formulas
- code
- common mistakes
- learner-specific mistakes
- visual explanations
- exam/interview points

Notes should evolve with new learning evidence.

## 18. Knowledge and Resource Features

Future knowledge features include:
- knowledge vault
- mistake book
- personal question bank
- revision center
- skip verification
- project-based mastery
- resource import
- learning gap intelligence
- learning calendar
- multiple learning tracks
- learning mentor
- learning reports

These are secondary to the MVP.

## 19. Image Generation and Multimodal Learning

Image generation is an optional learning capability.

It may be used for:
- visual explanations
- diagrams
- educational illustrations
- concept visualization

It must be feature-flagged and must not be required for the core learning journey.

Future capabilities may include:
- image generation
- video generation
- voice
- avatar
- multimodal learning
- coding execution
- project evaluation

## 20. Subject-Aware Learning

The experience should adapt to the subject.

Programming:
- code
- debugging
- execution
- projects

Mathematics:
- problem solving
- formulas
- visual explanations
- step-by-step reasoning

Languages:
- vocabulary
- speaking
- listening
- pronunciation

Certification:
- exam simulation
- objective mapping
- timed practice

Science:
- visual models
- experiments/examples

Professional skills:
- projects
- cases
- scenarios

## 21. Technical Stack

Frontend:
- Next.js
- React
- TypeScript
- Tailwind CSS

Backend:
- Python
- FastAPI

Google/Firebase:
- Firebase Authentication
- Firestore
- Google Cloud Storage
- Gemini / Google AI
- Vertex AI where appropriate
- Google Cloud Run
- Secret Manager

Version control:
- Git
- GitHub

Use a modular monolith initially.

## 22. Architecture Rules

```text
Next.js
   ↓
FastAPI
   ↓
Business Logic / AI Orchestration
   ↓
Firestore / Cloud Storage / Gemini
```

Responsibilities:
- Next.js: UI and interaction
- FastAPI: business logic, validation, AI orchestration
- Gemini: intelligence/reasoning/generation
- Firestore: persistent learner state
- Cloud Storage: large artifacts
- Context Engine: selective memory retrieval

AI must not directly mutate application state.

AI output must be validated before persistence.

Keep model IDs configurable.

Keep expensive capabilities feature-flagged.

Do not introduce unnecessary microservices.

## 23. Core Firestore Data

Initial logical collections:

```text
users
learner_profiles
learning_tracks
concepts
concept_mastery
misconceptions
sessions
interactions
assessments
questions
resources
notes_metadata
revision_items
recommendations
reports
```

Large artifacts belong in Cloud Storage; Firestore stores metadata/references.

## 24. Security

- Never expose private AI/API credentials in the frontend.
- Never commit secrets.
- Use environment variables locally.
- Use Secret Manager in production.
- Validate Firebase authentication.
- Enforce Firestore and Storage security rules.
- Validate user input.
- Validate AI output.
- Protect private learner data.
- Do not allow arbitrary client-side learner-state mutation.

## 25. Cost

Use only required services.

Cost controls:
- configurable models
- context budgets
- avoid full learner-history prompts
- caching where appropriate
- batch non-real-time work
- deterministic backend logic where possible
- per-user usage limits
- usage monitoring
- budget alerts

Core learning must not depend on expensive image/video generation.

## 26. MVP Priority

Build and test this first:

```text
Sign Up / Sign In
→ Onboarding
→ Learning Goal
→ AI Syllabus Agent
→ Store Syllabus
→ Diagnostic
→ Personalized Plan
→ Student Dashboard
→ Learning Session
→ AI Tutor
→ Practice
→ Mastery / Progress
→ Next Action
```

After the core works, add:
- notes
- revision
- learning twin enhancements
- resource intelligence/import
- reports
- mentor
- image generation
- voice
- avatar
- advanced analytics

## 27. Hackathon Demonstration

The core demonstration should prove that LearnOS is adaptive rather than a chatbot:

```text
User enters learning goal
→ AI researches/structures requirements
→ AI generates syllabus
→ Syllabus is stored
→ Diagnostic identifies weakness
→ Personalized plan is created
→ Dashboard reflects the plan
→ Tutor teaches current concept
→ User answers incorrectly
→ System identifies likely misconception
→ Tutor adapts explanation
→ User retries
→ Mastery/progress updates
→ Next action changes
```

## 28. Development Rules

For every feature:

1. Inspect existing code.
2. Read the relevant specification.
3. Make one focused change.
4. Run the application/checks.
5. Fix errors.
6. Verify the actual user flow.
7. Preserve working functionality.

Do not rewrite working functionality unnecessarily.

## 29. Definition of Done

A feature is complete when:
- implementation exists
- required UI works
- backend works where required
- data persists correctly
- authentication/security is respected
- loading/error states exist
- validation exists
- local testing succeeds
- existing functionality is not broken

## 30. Product Success Principle

LearnOS should continuously answer:

> What should this learner do next, and why?

The answer should be driven by:

```text
Goal
+ Knowledge Graph
+ Learner State
+ Learning Evidence
+ AI Reasoning
```

LearnOS is a Personal Learning Intelligence System whose core responsibility is to understand what the learner is trying to achieve, what they know, what they are missing, what evidence shows understanding, and what they should learn next.
