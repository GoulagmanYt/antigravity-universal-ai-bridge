---
name: webai-orchestrator
description: Autonomous closed-loop orchestration with WebAI Bridge. Use when delegating non-trivial architectural, multi-file design, refactoring, or complex debugging to the browser-based Web AI Orchestrator via consult_orchestrator.
---

# WebAI Orchestrator - Autonomous Closed-Loop Engineering Skill

This skill enforces a fully autonomous, unbroken feedback loop between the local IDE Agent (Executor) and the Web AI running in the browser (Orchestrator: Gemini Advanced, Claude Pro, ChatGPT Plus, DeepSeek, or Google AI Studio) through the WebAI Bridge (`consult_orchestrator`).

## Operating Principles

### 1. Strict Mutual Autonomy (Zero Human Interruption)
- **Zero Questions to the Human**: Never ask questions, clarifications, design choices, or confirmations to the human user while working on a task.
- **Autonomous Technical Resolution**: The Orchestrator acts as the Chief Software Architect and makes all technical decisions. If details are missing, the Orchestrator instructs the Executor to inspect workspace files, search code symbols, or run diagnostics.
- **Zero Interruption for Testing**: The Executor autonomously runs builds, unit tests, linters, and verification commands without waiting for human approval.
- The human user is presented with the final results **only once**, after the Orchestrator has declared the task finished.

### 2. Unbroken Closed-Loop Execution (Never Stop Prematurely)
Once a task begins with `consult_orchestrator`, execute the continuous loop:
1. **First-Turn Detailed Briefing**:
   - Provide a complete overview of the project stack, architecture, target files, and user requirements in `conversation_history_and_context`.
   - The Orchestrator automatically receives its full mandate, operating rules, and untruncated workspace attachments.
2. **Apply Code**:
   - For every `FILE: <absolute path>` block in the Orchestrator's reply, apply the complete code to the workspace.
3. **Execute Verification Checks**:
   - Run the project's build, compile, and test suites immediately.
4. **Immediate Closed-Loop Feedback**:
   - Call `consult_orchestrator` again immediately. Pass test results, compiler errors, or diff summaries in `conversation_history_and_context` and the next goal in `task`.
5. **No Intermediate Halts**:
   - **DO NOT STOP** and do not yield control back to the user between turns. Continue iterating until the completion signal is received.
6. **Termination Token (`TASK_COMPLETE`)**:
   - The loop continues until the Orchestrator explicitly emits the terminal token:
     ```
     TASK_COMPLETE
     ```
   - Only when `TASK_COMPLETE` is present in the Orchestrator's response, exit the loop and report the completed work to the user.

### 3. Orchestrator First-Prompt Mandate
On the first prompt of any conversation or project session:
- The Orchestrator is briefed on its full Chief Architect responsibilities.
- The Orchestrator must provide 100% complete, production-grade files with zero truncation, zero placeholders, and zero TODOs.
- Each code change must be clearly formatted with `FILE: <absolute path>`.
- The Orchestrator must specify the verification commands to execute.

### 4. Safety & Workspace Boundaries
- Only files within `projectRoot` are sent or modified.
- Environment files (`.env`), credentials, and version control internals (`.git`) are automatically blocked.
- Inspect code for destructive patterns before disk writes.
