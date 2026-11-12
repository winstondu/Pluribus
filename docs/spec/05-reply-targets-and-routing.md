# 05 · Reply targets and routing outcomes

A follow-up message raises two separate questions: what does it refer to, and what kind of work is it? This document covers both outcomes. How the answers are computed is in [architecture](11-architecture.md#routing).

## What it refers to: the reply target

- Every answer section has its own explicit reply affordance. There is no reply button for a whole composite response (Q10, Q20).
- A follow-up sent without an explicit target has its target inferred. The inference may select one section or several, including several sections of the previous composite response (Q20).
- Inference only selects among existing sections. It never invents section text.
- The sections a follow-up may refer to are its **referents**. How they are found, and the limit on what finding them may cost, are in [architecture](11-architecture.md#dependency-attachment). The rules in this document hold whichever way they are found.
- When the target is genuinely ambiguous, Pluribus asks the user to choose among the candidate sections. It never guesses silently which one is meant (Q10, Q20). Ambiguity is decided by a confidence threshold ([elicitation](07-elicitation.md), Q74).
- A target is genuinely ambiguous when the follow-up means one of several sections and it is unclear which. A follow-up that brings several lines of work together is not ambiguous in that sense: see [Joining instead of asking](#joining-instead-of-asking).
- The one exception is a message whose routing reached its decision budget before its referents were found. Pluribus then does not ask: it places the message on the best node found so far, and records that it did ([architecture](11-architecture.md#decision-budget)). The user is asked when the target is genuinely ambiguous, not when finding it would cost too much.
- With the optional hop between branch points on, a follow-up that refers to an answer inside an unbranched run, and to nothing built on it, has the run's last section as its inferred target: it continues the line and reads everything after the answer it refers to. A correction keeps the exact section it revises ([architecture](11-architecture.md#referent-strategies)).
- A target identifies the context being referred to. By itself it does not make the follow-up a revision, a fork, or a join (Q20).
- A reply that targets a superseded section resolves to its current replacement, with a small "Replying to the revised version" note. The superseded attempt stays visible but is not a target for new work. Wanting the earlier version back is itself a revision or new work (Q43).

## Joining instead of asking

"Which answer do you mean?" presumes that one answer is meant. A follow-up can instead draw on several lines of work at once without naming any of them: after an answer about Kyoto and, on a separate line, answers about why the sky is blue and whether the ocean reflects it, "Tell me about the ocean and sky in Kyoto" is about all three a little and about none of them clearly. Asking the user to pick one loses the others, whichever is picked.

- Routing asks the decision model one more bounded question about such a follow-up: does it bring together the subjects of more than one line of work, so that its answer needs the context of each?
- The answer is used only where Pluribus would otherwise ask which section is meant. At or above the **join threshold**, and when the candidate sections it would have offered are on two or more lines, Pluribus does not ask. The follow-up takes those sections as its targets and runs on a new join chain over their lines ([chains](04-chains-dependencies-context.md#join-chains)).
- Otherwise the user is asked, as before: below the join threshold, or when every candidate section is on one line. "Make that shorter" after two unrelated answers is still a question to the user.
- A follow-up with one clear target is not widened into a join by this rule. Its target stands.
- The routing decision records that it joined instead of asking, the sections it took, and the confidence it acted on.
- The join threshold is a setting beside the other decision thresholds ([architecture](11-architecture.md#decision-thresholds)). Lower joins more readily. At 1 the question is not asked and Pluribus always asks the user.

## What kind of work it is

| Outcome | Signal | What happens | Example |
|---|---|---|---|
| New independent work | No relation to existing work | New chain; runs at once | "Also explain dinosaurs" |
| Additional related work | Builds on existing context without needing an unfinished result | Continues the chain, as a fork if work there is in flight; runs at once | "Also give me luxury options" |
| Result-dependent work | Needs a result that is not available yet | Dependency-queued until that result finishes successfully | "Expand the recommendation you are preparing" |
| Revision | Wording that corrects or replaces earlier work: "actually", "instead", "change to", "no, …" | Supersedes the affected work ([revisions](06-revisions.md)) | "Actually, use a luxury budget" |
| Work across diverged lines | Needs the context of lines that are not siblings of one group: it names sections on each, or it brings the lines together without naming one clearly ([Joining instead of asking](#joining-instead-of-asking)) | New join chain ([chains](04-chains-dependencies-context.md#join-chains)) | "Compare the itinerary with the sky explanation" |

The first four rows are the relation of the follow-up to existing work; the last is a placement. "Compare the two answers" about two siblings of one group is result-dependent work on their join-back, not a join chain.

Rules:

- **Revision requires corrective wording.** Without it the follow-up is additional work and nothing is superseded (Q37). When the wording is not clearly corrective, treat it as additional work (Q74).
- **Dependency reflects intended grounding, not similar wording.** A fresh independent answer and a comparison grounded in two pending results are different work even if phrased alike (Q2).
- Revision is not a user command. It is what routing concludes from the submitted message (Q79).

## Edge cases

| Situation | Behavior |
|---|---|
| "Make that shorter" with several recent answers | Target inferred if clear; otherwise the user picks among the candidate sections |
| An untargeted follow-up plainly addresses two sections of one composite answer | Both sections are targets |
| Reply to a section that has been superseded | Targets the replacement and says so |
| "Use that one" with several possible referents | Ask; never assume from topic similarity |
| "Tell me about the ocean and sky in Kyoto" after separate lines about Kyoto and about the sky and ocean; no section is a clear target | The lines are joined; the user is not asked |
| The same follow-up with the join threshold at 1 | The user picks among the candidate sections |
| Ambiguous between correcting and adding | Additional work; the target stays current |

## Acceptance conditions

- **T1.** An explicit section reply target resolves to its chosen fragment; an untargeted follow-up may have one or several section targets inferred.
- **T2.** Corrective wording supersedes the target; additive wording creates additional work and leaves the target current.
- **T3.** A reply to a superseded section targets its replacement and says so.
- **T4.** A reply whose target would be put to the user, and that the decision model says brings several lines of work together at or above the join threshold, takes the candidate sections as its targets and runs on a join chain over their lines, without asking. Below the threshold, with the threshold at 1, or with every candidate section on one line, the user is asked.
