


When I select a session, sage performs the initial review / context retrieval. This gets sage up to date on the current state of the code, what we are doing in the conversation. 
Then, as I prompt furthor, sage will automatically review each new prompt / response pair.  
If I prompt again and claude code finishes its response before sage has completed its review on the previous prompt, that prompt/response will be added to a queue. This queue will be displayed to the user (showing the truncated user prompt)

Implementation 
After claude code finished a response, a hook is triggered that runs specstory 

Claude finishes → Stop hook → specstory sync -s {sessionId} -outputdir .sage/history/  →
updates .sage/history/ → 
Sage detects file change → reads markdown → reviews

We will have a sage watcher watch 


That's actually a much cleaner approach! Let me think through this:

  Your Proposed Flow:

  Claude finishes → Stop hook → specstory sync -s {sessionId} →
    updates ~/.sage/sessions/{sessionId}/*.md → 
    Sage detects file change → reads markdown → reviews

  Compared to My Proposal:

  Claude finishes → Stop hook → append to events.jsonl →
    Sage reads event → specstory sync → reads markdown → reviews

  ---
  Why Your Approach is Better:

  ✅ Simpler architecture - No intermediate event queue file✅ Markdown is the event - File change = new turn✅ Less code - No event parser, no JSONL format, just file
  watching✅ Single source of truth - Markdown file has everything✅ Idempotent - Multiple hooks firing won't cause issues (specstory overwrites)

  ---
  Potential Concerns:

  1. Hook Latency

  Q: Will running specstory in the hook block Claude?A: Hooks run async and return immediately. SpecStory with --silent is fast (~500ms-1s). Should be fine.

  2. Race Conditions

  Q: Multiple rapid turns → multiple specstory processes?A: Each overwrites the same file. Last one wins. Sage might review mid-turn but next change triggers re-review.

  Solution: Add debouncing (wait 500ms after file change before reviewing)

  3. File Watch Reliability

  Q: What if file write happens in chunks?A: Use fs.watch() with debounce. SpecStory writes atomically (creates temp file, renames).

  ---
  Implementation Differences:

  Hook script becomes:
  #!/usr/bin/env node
  const { execSync } = require('child_process');

  let input = '';
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    const hookData = JSON.parse(input);
    const sessionId = hookData.session_id;

    // Run specstory sync for this session
    execSync(`specstory sync claude -s ${sessionId} --output-dir ~/.sage/sessions/${sessionId} --silent --no-version-check`);
  });

  Sage watcher becomes:
  // Watch the markdown file for selected session
  const mdPath = `~/.sage/sessions/${sessionId}/*.md`;
  fs.watch(mdPath, debounce(() => {
    const markdown = fs.readFileSync(mdPath, 'utf-8');
    triggerReview(markdown);
  }, 500));

  ---
  My Verdict: Do it your way! It's cleaner.

  The only tradeoff is hook latency (adding 500ms-1s to each turn), but that's acceptable. The architectural simplicity is worth it.

  Should we update the continuous mode plan with this approach?