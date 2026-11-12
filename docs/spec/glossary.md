# Committee glossary

A single visible conversation containing independently progressing agent work, with explicit relationships between requests, context, and results.

## Language

### Messages and requirements

**Original message**:
The user's intact submitted message, preserved even when its work is decomposed.
_Avoid_: Fragment (for the intact submission)

**Atomic message**:
A request treated as one coherent intent; tightly related topics or an integrated output can form one atomic message.
_Avoid_: Single-topic message

**Composite message**:
A request containing independent intents that can be separated while preserving applicable shared requirements.

**Fragment**:
An atomic request extracted or rewritten from a composite message, associated with its source and applicable shared requirements.

**Split message**:
One of the separate user messages shown, in dependency order, when a composite message's later part needs an earlier part's result. Each is its own target; the original message stays available.

**Shared requirement**:
A requirement in a message that applies to more than one of its fragments, or an established brief that several requests consumed.

**Requirement scope**:
How far a requirement reaches. Local (the default) covers only the addressed request or fragments; session-wide covers the whole conversation and applies only when the user says so explicitly.

### Chains and context

**Chain**:
A continuing line of agent conversation with its own context ancestry, distinct from the full visible chat.
_Avoid_: Entire chat (when referring to one chain)

**Handling chain**:
The chain responsible for a message fragment or answer, distinct from other chains whose context it inherits.

**Fork**:
A parallel continuation from an existing chain's context, whose concurrent sibling results are not yet part of that context. Each fork is shown in its own chain color.

**Sibling group**:
Parallel forks sharing the same starting context, including additional forks from that context while the group remains open. Descendants consuming a sibling's result are outside the group; membership closes, and the join-back forms, once every member has completed or has failed, been stopped, or been interrupted and is not retrying.

**Join-back**:
An automatic record of completed parallel exchanges for a future continuation, forming a child of all participating siblings without synthesizing their conclusions. The siblings remain independently continuable. Work continuing from it is on the chain the siblings forked from.
_Avoid_: Synthesis

**Join chain**:
A new chain whose parents are leaf nodes of two or more source chains, which remain independently continuable. Sources may be leaf-node cousins within one tree or previously separate trees. Work that merely continues from a join-back is not a join chain.
_Avoid_: Join-back (when referring to a new chain), merge chain

**Result dependency**:
A relationship in which one request needs a result that another produces; shared subject matter alone is not a result dependency.

### Work and its states

**Directive**:
The unit of work that produces one answer section: an atomic request, or one fragment of a composite. It fails, stops, and retries on its own.
_Avoid_: Task, job

**Attempt**:
One execution of a directive. A revision stops or supersedes the affected attempt and starts a replacement attempt; earlier attempts remain visible history.

**Revision**:
A change to previously requested work, signalled by corrective or replacing wording, that supersedes affected work rather than adding a fork or result-dependent follow-up. Work that has not started is updated in place and nothing is superseded.

**Superseded**:
The state of an attempt or result replaced by a revision, including a running attempt that Committee ends in order to replace it. It is retained, not rewritten, and is no longer the prerequisite for work that follows. Work that depended on it follows the replacement; it is not paused.
_Avoid_: Deleted, failed

**Superseded-input note**:
A quiet marker on completed work that consumed a result which has since been replaced. The work is left as it was, with the option to regenerate it.
_Avoid_: Stale (as a state name), invalid

**Failed**:
An attempt that ended in an execution error after any automatic retries. Local to its directive; never an overall request state.

**Stopped**:
An attempt the user ended deliberately. Visible text stays as partial; distinct from failed.

**Cancelled**:
Work the user cancelled before it started, such as queued work inside a stopped request or a paused request the user chose not to run. Applies to a directive, never to a request as a whole.
_Avoid_: Stopped (which applies to work that had started)

**Interrupted**:
An attempt lost because whatever was executing it stopped unexpectedly (app closed, connection lost, crash). Distinct from failed and stopped.

**Retry**:
A new attempt at the same request after a failed, stopped, or interrupted one, automatic or user-initiated. It replaces the earlier attempt without revising what was asked.
_Avoid_: Revision, regenerate

**Regenerate**:
A user-initiated redo of work whose input has since been replaced, cancelling any of that work still in progress.
_Avoid_: Retry, revision

**Paused**:
A dependency-queued request whose prerequisite failed, was stopped, or was interrupted, waiting for the user's recovery choice.

**Dependency-queued message**:
A submitted request waiting for a required result from in-flight work, distinct from independent work that is eligible to proceed.
_Avoid_: Draft, waiting for capacity

**Waiting for capacity**:
Ready work held back by a provider's rate limit, not by a missing result.
_Avoid_: Queued, dependency-queued

### Conversation with the user

**Reply target**:
The answer section or sections addressed by a follow-up, selected explicitly or inferred from its meaning. A target identifies referenced context without by itself deciding whether work is a revision, fork, or join.

**Elicitation**:
Committee asking the user to decide something it will not or cannot decide alone: which section a reply addresses, missing information, which work to redo, or how to recover.

**Clarification continuation**:
Additional responses that ask for missing information and later deliver the affected results, remaining associated with the original request without reopening its earlier answer.

**Choice with default**:
An elicitation that pre-selects a reasonable, reversible action and carries it out if the user does not answer.

**Recovery choice**:
The elicitation shown for a paused request: retry the prerequisite, continue without it, or cancel. It has no default.

### Routing

**Referent**:
An existing answer section that a message or fragment may refer to, together with how confident routing is that it does. Referents that are confident enough become reply targets; a weaker one is put to the user, never assumed, unless the decision budget was reached.
_Avoid_: Reply target (for a section routing has not yet accepted)

**Dependency attachment**:
The part of routing that decides which earlier work a message or fragment attaches to: its referents, and from them its reply targets, its place in the genealogy, and the results it waits for.

**Referent strategy**:
The interchangeable method by which dependency attachment finds and scores referents. The rules that turn referents into targets, placement, and dependencies are the same for every strategy.
_Avoid_: Algorithm, router (for the strategy alone)

**Branch point**:
A place where a line of work splits into two or more continuations, including the join-back of a sibling group.

**Unbranched run**:
The answers of one line of work between two branch points, each continuing the one before.
_Avoid_: Run (which is one model call: "a run's context"), segment (which is the operation that asks about part of an unbranched run), stretch

**Trunk**:
The first unbranched run of a line of work that starts from nothing: from its first answer to its first branch point, or to its latest answer when it never splits. Its last answer is the trunk base.

**Relevant node**:
A section, or a sibling group's join-back, that a message or fragment actually refers to. Routing cannot see which nodes are relevant; it can only ask.

**Deepest relevant nodes**:
The relevant nodes that have no relevant descendant. They are what dependency attachment looks for: the context of each holds every relevant node above it. Inside an unbranched run this is the last relevant section. With hop between branch points on, the last section of that unbranched run is taken in its place.
_Avoid_: Best leaf, leaves (a deepest relevant node need not be a leaf)

**Operation**:
One of the fixed things a referent strategy can do: Point (ask about one section by itself), Group (ask about a sibling group as a whole), Segment (ask about part of an unbranched run), Several (ask whether the message refers to more than one section), and the ones that ask nothing: Estimate, Structure, Describe, Cost. Only Point and Group can confirm a referent; the one exception is the last section of an unbranched run under hop between branch points.
_Avoid_: Question (for an operation that asks nothing), tool

**Hop between branch points**:
An optional switch of the tree walk, off by default. A message that refers to an unbranched run, and to nothing built on it, is placed on the run's last section without a search for the last relevant section inside the run. It saves decision tokens; the answer then reads everything after the relevant part of the run. Corrections are never placed this way.
_Avoid_: Skip, jump, hops (for the setting)

**Candidate sections**:
Sections handed to the tree walk as starting nodes in addition to the roots, for example the ones a retrieval index finds closest to the message. A candidate is where the walk starts looking; it is not a referent until a Point confirms it.
_Avoid_: Candidates (for the sections the best node found so far is chosen from), hits

**First-pass sections**:
The few most recent answer sections that no later one of them builds on. Every routing asks about each of them by itself before anything else.

**Decision budget**:
The limit on the decision-model work that routing one message may use: a number of tokens, fixed or a share of what the conversation has recorded, and never more than a set multiple of the cost of the answer being routed. It is a hard stop: when it is reached nothing more is asked, of the decision model or of the user.
_Avoid_: Rate limit, concurrency limit

**Best node found so far**:
The section, or the sibling group as a whole, that a message is placed on when its routing reached the decision budget before its target was clear: the best of those that were asked about by themselves and are at least plausible, the last section of an unbranched run taken by hop between branch points among them. The user is not asked.
_Avoid_: Best leaf, guess

**Context summary**:
A stored summary of the context of one point in the genealogy, shown to the decision model in place of that context when routing. It is never part of the context a run reads.
_Avoid_: Compaction (which would shorten what a run reads and is out of scope)

**Strategy selection**:
An optional step that chooses the referent strategy for each message from the shape of the conversation's genealogy alone, by fixed rules or by asking the decision model.
_Avoid_: Decision-inception (the working name)

### Presentation

**Answer section**:
An independently progressing portion of an assistant response, produced by one directive. An atomic message's answer is a single section.

**Responding bubble**:
A pending-answer placeholder, shown until its first answer text appears. A reply that shows answer text first takes its place above it.

**Reply group**:
The answer sections for one composite message, kept together at one position in the transcript.

**Additional response**:
A later response associated with an earlier request, used for clarification questions, the answers they unblock, and revision replacements. It is never inserted into the earlier response.

**Queue item**:
The entry above the composer linked to a submitted message that is waiting, naming what it waits for. It clears when processing begins; the message itself stays in the transcript.
