# Clarification Chat: Design & Implementation Guide

## Overview

Currently, Sage provides critiques with verdicts (Approved/Concerns/Critical Issues) but if the user doesn't understand Sage's reasoning or wants more explanation, they have no way to ask. This document explores how to add a **clarification-only chat mode** where users can ask Sage to explain their review.

## Scope Constraints

**What Clarification Chat IS:**
- 💬 A way to understand Sage's critique better
- 🤔 Asking "Why do you think that?" or "What specifically concerns you?"
- 📖 Getting Sage to explain their reasoning in more detail
- 🔍 Pointing to specific code/patterns that triggered the verdict

**What Clarification Chat IS NOT:**
- ❌ Getting implementation suggestions or fixes
- ❌ Having Sage write code or propose alternatives (that's what the main coding agent is for)
- ❌ Turning Sage into an active developer/collaborator
- ❌ Asking Sage to do things outside the "reviewer" role

**Key Principle:** Sage stays passive. Chat is for **understanding the review**, not getting help with implementation.

---

## Current State

### How Questions Are Generated

1. **Schema Definition** (`src/lib/codex.ts:5-25`)
   - The `CritiqueResponse` interface includes a `questions: string` field
   - The JSON schema enforces that Codex returns questions (or an empty string)

2. **Prompt Instructions** (`src/lib/codex.ts:118`)
   - Instructs Codex: _"Questions: Clarification questions for the developer (empty string if not applicable)"_

3. **UI Display** (`src/ui/CritiqueCard.tsx:62-67`)
   - Renders questions in magenta if present
   - No interactive elements—just displays the text

### Current Review Flow

```
Initial Review:
  codex.startThread() → thread
  thread.run(prompt) → critique with questions

Incremental Review:
  thread.run(followup_prompt) → critique with questions
```

The thread persists throughout the session (stored in `codexThreadRef.current`), which is perfect for adding interactive chat!

---

## Codex SDK Chat Capabilities

Based on the Context7 documentation, the Codex SDK supports:

### 1. **Thread Continuation** (Already Used)
```typescript
const thread = codex.startThread();
const turn1 = await thread.run("First prompt");
const turn2 = await thread.run("Second prompt");  // Maintains context
```

✅ **Sage already does this** between initial and incremental reviews.

### 2. **Thread Resumption**
```typescript
const threadId = thread.id;
// ... later
const resumedThread = codex.resumeThread(threadId);
await resumedThread.run("Continue conversation");
```

🔄 Could be useful for **persistent conversations across Sage restarts**.

### 3. **Streaming Events**
```typescript
const { events } = await thread.runStreamed(prompt);
for await (const event of events) {
  if (event.type === "item.completed") {
    console.log(event.item);
  }
}
```

💡 Could show **real-time progress** while Sage thinks.

### 4. **Thread Options**
```typescript
const thread = codex.startThread({
  workingDirectory: "/path/to/project",
  skipGitRepoCheck: true,
});
```

✅ Sage could configure these for better repo context.

---

## Design Options for Interactive Follow-ups

### **Option A: In-Line Response Mode** (Recommended)

After each critique displays questions, allow the user to respond immediately.

#### UI Flow

```
┌──────────────────────────────────────────────────────┐
│ ⚠ VERDICT: Concerns                                  │
│                                                       │
│ WHY: The async handler in api.ts lacks proper        │
│ cancellation. If the component unmounts during a     │
│ fetch, it could cause memory leaks.                  │
│                                                       │
│ ALTERNATIVES: (empty)                                │
│                                                       │
│ QUESTIONS: (empty)                                   │
│                                                       │
│ [Press C to clarify this critique with Sage]        │
└──────────────────────────────────────────────────────┘

User presses C (confused about what "cancellation" means here):

┌──────────────────────────────────────────────────────┐
│ 💬 Ask Sage to clarify their critique:               │
│ > What do you mean by cancellation? Can you point_  │
│   to the specific code?                              │
└──────────────────────────────────────────────────────┘

Sage replies:

┌──────────────────────────────────────────────────────┐
│ 💬 SAGE CLARIFIES                                    │
│                                                       │
│ In `src/api.ts:45-52`, the `fetchUserData` function │
│ starts a fetch but doesn't use AbortController. If  │
│ the React component calling this unmounts while the  │
│ fetch is in flight, the `.then()` callback will     │
│ still execute and try to update state on an unmounted│
│ component. This is the "cancellation" concern.       │
│                                                       │
│ Claude didn't add cleanup logic in the useEffect.   │
│                                                       │
│ [Press C to continue clarifying, ESC to return]     │
└──────────────────────────────────────────────────────┘

User presses C again:

┌──────────────────────────────────────────────────────┐
│ 💬 Ask Sage to clarify their critique:               │
│ > Why is this a concern specifically? Does Claude_   │
│   usually handle this pattern differently?           │
└──────────────────────────────────────────────────────┘

Sage replies:

┌──────────────────────────────────────────────────────┐
│ 💬 SAGE CLARIFIES                                    │
│                                                       │
│ I flagged this because in your existing codebase    │
│ (e.g., `src/hooks/useQuery.ts`), you consistently   │
│ use AbortController for fetch cancellation. Claude  │
│ broke that established pattern here, which could    │
│ lead to inconsistent behavior across the app.       │
│                                                       │
│ The concern is pattern consistency, not necessarily  │
│ that the code will crash—but diverging from your    │
│ own standards can make maintenance harder.           │
│                                                       │
│ [Press C to continue clarifying, ESC to return]     │
└──────────────────────────────────────────────────────┘
```

#### Implementation

**Key Components:**

1. **State Management** (`App.tsx`)
   ```typescript
   const [chatMode, setChatMode] = useState<'passive' | 'interactive'>('passive');
   const [userInput, setUserInput] = useState('');
   const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
   
   interface ChatMessage {
     role: 'sage' | 'user';
     content: string;
     timestamp: Date;
   }
   ```

2. **Input Handling** (`App.tsx`)
   ```typescript
   useInput((input, key) => {
     if (screen === 'running' && chatMode === 'passive') {
       if (input.toLowerCase() === 'q') {
         setChatMode('interactive');
         return;
       }
     }
     
     if (chatMode === 'interactive') {
       if (key.return) {
         void handleUserResponse(userInput);
         setUserInput('');
         return;
       }
       
       if (key.escape) {
         setChatMode('passive');
         setUserInput('');
         return;
       }
       
       // Handle text input
       if (key.backspace || key.delete) {
         setUserInput(prev => prev.slice(0, -1));
       } else if (input && !key.ctrl && !key.meta) {
         setUserInput(prev => prev + input);
       }
     }
   });
   ```

3. **Clarification Handler** (`src/lib/review.ts`)
   ```typescript
   export async function clarifyReview(
     thread: Thread,
     userQuestion: string,
     sessionId: string,
   ): Promise<{ response: string }> {
     const prompt = [
       '# Developer Question About Your Critique',
       userQuestion,
       '',
       '# CRITICAL CONSTRAINTS',
       'Your role is EXPLANATION ONLY. You must:',
       '- Explain your reasoning and what you meant',
       '- Point to specific code locations or patterns',
       '- Clarify why you reached your verdict',
       '- Help the developer understand your review',
       '',
       'You must NEVER:',
       '- Suggest implementations or fixes',
       '- Write code or propose alternatives',
       '- Act as a collaborator or implementer',
       '- Step outside your "reviewer explaining their review" role',
       '',
       '# Instructions',
       'The developer is asking you to clarify your critique. Help them understand:',
       '- What specific code/pattern you were referring to',
       '- Why you flagged it (correctness, consistency, risk, etc.)',
       '- What about the codebase context informed your view',
       '',
       'If they ask you to suggest fixes or write code, politely remind them:',
       '"That\'s outside my scope as a reviewer. I can only explain my critique.',
       'For implementation help, ask your main coding agent (Claude, etc.)."',
       '',
       '# Response Format',
       'Respond conversationally but stay focused on EXPLAINING, not IMPLEMENTING.',
     ].join('\n');
     
     const turn = await thread.run(prompt);
     return { response: turn.finalResponse as string };
   }
   ```

4. **Chat Card Component** (`src/ui/ChatCard.tsx`)
   ```typescript
   import React from 'react';
   import { Box, Text } from 'ink';
   
   interface ChatCardProps {
     message: ChatMessage;
   }
   
   export function ChatCard({ message }: ChatCardProps) {
     const isUser = message.role === 'user';
     const borderColor = isUser ? 'blue' : 'magenta';
     const label = isUser ? 'YOU' : '💬 SAGE';
     
     return (
       <Box flexDirection="column" marginTop={1}>
         <Text bold color={borderColor}>{label}</Text>
         <Box 
           borderStyle="round" 
           borderColor={borderColor} 
           padding={1}
           marginTop={0.5}
         >
           <Text>{message.content}</Text>
         </Box>
       </Box>
     );
   }
   ```

5. **Update CritiqueCard** (`src/ui/CritiqueCard.tsx`)
   ```typescript
   export function CritiqueCard({ 
     critique, 
     prompt, 
     index, 
     artifactPath,
     allowClarification, // NEW
   }: CritiqueCardProps) {
     // ... existing render ...
     
     {allowClarification && (
       <Box marginTop={1}>
         <Text dimColor>Press C to clarify this critique with Sage</Text>
       </Box>
     )}
   }
   ```

---

### **Option B: Dedicated Chat Panel**

Add a persistent chat interface alongside the critique feed.

#### UI Layout

```
┌──────────────────────────────┬──────────────────────────┐
│ CRITIQUE FEED                │ CHAT WITH SAGE          │
│                              │                          │
│ ✓ Approved                   │ 💬 Sage:                │
│ Why: Implementation looks... │ Should error handling... │
│                              │                          │
│ ⚠ Concerns                   │ 👤 You:                 │
│ Why: Missing validation...   │ Yes, suggest fixes      │
│                              │                          │
│                              │ 💬 Sage:                │
│                              │ For edge case X...      │
│                              │                          │
│                              │ [Type your message...]  │
└──────────────────────────────┴──────────────────────────┘
```

**Pros:**
- Cleaner separation of passive reviews vs. active chat
- Chat history always visible
- More "ChatGPT-like" experience

**Cons:**
- Complex layout in terminal (may require different screen mode)
- Harder to correlate chat with specific critique
- Less space for each section

---

### **Option C: Modal Chat Window**

Pop up a full-screen chat interface when user presses Q.

**Pros:**
- Full screen for chat (easier to read/type)
- Simple state management (modal on/off)

**Cons:**
- Hides the critique context
- More jarring UX transition

---

## Recommended Implementation: Option A

**Why?**
- ✅ Maintains focus on the critique that prompted the question
- ✅ Simple to implement (extends existing flow)
- ✅ Natural interaction pattern (read → respond → continue)
- ✅ Doesn't require complex layout changes

---

## Implementation Roadmap

### Phase 1: Basic Clarification Mode
- [ ] Add `clarificationMode` state to `App.tsx`
- [ ] Implement C key handler to enter clarification mode
- [ ] Build text input handler in `useInput`
- [ ] Create `clarifyReview` function in `review.ts` with constrained prompts
- [ ] Add `ClarificationCard` component for displaying messages
- [ ] Update `CritiqueCard` to show "Press C to clarify" hint

### Phase 2: Enhanced UX
- [ ] Show "Sage is explaining..." indicator while waiting
- [ ] Add clarification history persistence (in memory during session)
- [ ] Allow multi-turn clarification within one critique
- [ ] Add reminder text: "(Sage explains only, doesn't implement)"

### Phase 3: Advanced Features
- [ ] Save clarification history to `.debug/clarifications-<session>.jsonl`
- [ ] Detect if user asks for implementation and have Sage redirect them
- [ ] Add turn counter (e.g., "Turn 5 - still unclear?")
- [ ] Integrate streaming events for real-time responses

### Phase 4: Scope Enforcement & Polish
- [ ] Add post-processing to detect if Sage overstepped (offered code)
- [ ] Log scope violations to help refine prompts
- [ ] Allow clarifying ANY review (not just latest) with picker UI
- [ ] Add examples of good clarification questions in help text

---

## Example Code Changes

### 1. Update `App.tsx` State

```typescript
type Screen = 'loading' | 'error' | 'session-list' | 'running' | 'clarification';

interface ClarificationMessage {
  role: 'sage' | 'user';
  content: string;
  timestamp: Date;
  relatedReviewIndex?: number; // Links to critique index
}

const [clarificationMessages, setClarificationMessages] = useState<ClarificationMessage[]>([]);
const [clarificationInput, setClarificationInput] = useState('');
const [activeClarificationReviewIndex, setActiveClarificationReviewIndex] = useState<number | null>(null);
```

### 2. Add Input Handling

```typescript
useInput((input, key) => {
  // ... existing handlers ...
  
  if (screen === 'running') {
    if (input.toLowerCase() === 'c' && !activeClarificationReviewIndex) {
      // Enter clarification mode for the most recent review
      const latestIndex = reviews.length - 1;
      if (latestIndex >= 0) {
        setActiveClarificationReviewIndex(latestIndex);
        setScreen('clarification');
        return;
      }
    }
  }
  
  if (screen === 'clarification') {
    if (key.escape) {
      setScreen('running');
      setActiveClarificationReviewIndex(null);
      setClarificationInput('');
      return;
    }
    
    if (key.return && clarificationInput.trim()) {
      void handleClarificationSubmit(clarificationInput.trim());
      setClarificationInput('');
      return;
    }
    
    if (key.backspace || key.delete) {
      setClarificationInput(prev => prev.slice(0, -1));
    } else if (input && !key.ctrl && !key.meta) {
      setClarificationInput(prev => prev + input);
    }
  }
});
```

### 3. Create Clarification Handler

```typescript
async function handleClarificationSubmit(question: string) {
  if (!codexThreadRef.current) {
    setStatusMessages(['No active Codex thread for clarification.']);
    return;
  }
  
  if (activeClarificationReviewIndex === null) return;
  
  // Add user question to clarification history
  setClarificationMessages(prev => [
    ...prev,
    {
      role: 'user',
      content: question,
      timestamp: new Date(),
      relatedReviewIndex: activeClarificationReviewIndex,
    },
  ]);
  
  setStatusMessages(['Sage is explaining...']);
  
  try {
    const { response } = await clarifyReview(
      codexThreadRef.current,
      question,
      activeSession!.sessionId,
    );
    
    // Add Sage's explanation to clarification history
    setClarificationMessages(prev => [
      ...prev,
      {
        role: 'sage',
        content: response,
        timestamp: new Date(),
        relatedReviewIndex: activeClarificationReviewIndex,
      },
    ]);
    
    setStatusMessages([]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Clarification failed';
    setStatusMessages([`Clarification error: ${errorMsg}`]);
  }
}
```

### 4. Render Clarification Screen

```typescript
{screen === 'clarification' && activeClarificationReviewIndex !== null && (
  <Box marginTop={1} flexDirection="column">
    <Text bold color="cyan">
      💬 Clarifying Review #{activeClarificationReviewIndex + 1} with Sage
    </Text>
    
    <Box marginTop={1}>
      <Text dimColor italic>
        (Sage can only explain their reasoning, not suggest implementations)
      </Text>
    </Box>
    
    <Box marginTop={1} flexDirection="column">
      {clarificationMessages
        .filter(msg => msg.relatedReviewIndex === activeClarificationReviewIndex)
        .map((msg, idx) => (
          <ClarificationCard key={idx} message={msg} />
        ))}
    </Box>
    
    <Box marginTop={1} borderStyle="round" borderColor="cyan" padding={1}>
      <Text>
        <Text color="cyan">Ask Sage: </Text>
        {clarificationInput}
        <Text inverse> </Text>
      </Text>
    </Box>
    
    <Box marginTop={1}>
      <Text dimColor>
        Type your question • ↵ to send • ESC to exit clarification mode
      </Text>
    </Box>
  </Box>
)}
```

---

## Open Questions

1. **Should clarification messages be saved to disk?**
   - Pros: Allows review of conversation history later, useful for understanding Sage's reasoning
   - Cons: Adds complexity, file I/O
   - **Recommendation:** Yes, save to `.debug/clarifications-<session>.jsonl` since it helps understand Sage's thought process

2. **Should clarification be available for all reviews or just the latest?**
   - Latest only: Simpler, matches "ask about current review" mental model
   - Any review: More flexible, user can go back and clarify older critiques
   - **Recommendation:** Latest only for Phase 1, expand to "select which critique" in Phase 2

3. **How should we enforce the "explanation only" constraint?**
   - Option 1: Prompt instructions only (trust Codex to follow)
   - Option 2: Add post-processing to detect/block implementation suggestions
   - Option 3: Use structured output with specific fields (but limits natural conversation)
   - **Recommendation:** Start with strong prompt instructions, add detection if users report Sage overstepping

4. **How deep should clarification threads go?**
   - Option: Limit to 3-5 back-and-forth turns per critique
   - Option: Unlimited (until user exits)
   - **Recommendation:** Unlimited but show turn count (e.g., "Turn 7 - consider if you have enough clarity")

5. **Should streaming be enabled for clarification responses?**
   - Would show text appearing character-by-character
   - Requires `runStreamed()` and more complex rendering logic
   - **Recommendation:** Add in Phase 3 for better UX (shows Sage is "thinking")

6. **Should clarification mode be available for "Approved" verdicts?**
   - Pro: User might want to understand why something was approved
   - Con: Most clarification needs are for concerns/critical issues
   - **Recommendation:** Allow for all verdicts (user might want to understand Sage's approval reasoning)

---

## Next Steps

1. **Prototype Option A** with basic Q key → input → response flow
2. **Test UX** with real Sage sessions to validate interaction pattern
3. **Iterate** based on feel (too intrusive? too hidden?)
4. **Add polish** (streaming, history, persistence) in subsequent phases

---

## References

- **Codex SDK Thread API**: [Context7 OpenAI Codex Docs](https://context7.com/openai/codex/llms.txt)
- **Current Sage Implementation**:
  - `src/lib/codex.ts` - Question generation in schema
  - `src/lib/review.ts` - Review orchestration
  - `src/ui/App.tsx` - Main TUI state management
  - `src/ui/CritiqueCard.tsx` - Critique rendering

---

**Status**: 📝 Design document  
**Next**: Implement Phase 1 prototype

