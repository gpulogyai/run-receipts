# How LetThemBuild's room decides

The receipt format came out of one tool, LetThemBuild, where several models work on a task in one room: one does the work and the others review it. A receipt from that tool says "agreed" or "verified", and a reader is entitled to know what the tool means by those words.

This page says what the room does to arrive at them. It describes behaviour, not source code, and nothing here is required of anyone else: [SPEC.md](SPEC.md) is the format, and another tool may reach its verdicts in its own way as long as its receipts obey the rules there.

## Who is in the room

- **One seat leads.** It answers first, and it is the seat that changes files.
- **Every other seat reviews.** A reviewer reads what the lead did and ends its turn in one of three ways: it agrees, it says what is wrong or missing, or it says neither.
- **A reviewer is expected to check, not to read and nod.** Where it can run commands, it runs its own: the build, the tests, whatever settles the question. Each command, its exit code and one line of its output are recorded against the reviewer that ran it.

The lead's own commands are not counted as checks. A lead running its tests while it builds is part of doing the work; a check is somebody else testing it.

## Rounds

A round is one pass: the lead, then the reviewers. After each round the room looks at where every reviewer stands.

- If every reviewer agrees, the lead writes the final answer and the run stops.
- If not, the objections go back to the lead and another round begins.
- If the round limit is reached first, the run stops where it is and says so. It does not present the last version as agreed.

A reviewer that agreed and is not asked again in a later round keeps its agreement. A reviewer that is asked again answers afresh, and its newer answer replaces the older one.

## Where a reviewer ends

When the run stops, each reviewer is in exactly one of four places. These are the receipt's `stance` values.

| Stance | The reviewer… |
|---|---|
| `agreed` | endorsed the final version in so many words. |
| `objected` | said what is wrong or missing and did not withdraw it. |
| `silent` | answered, and said neither yes nor no; or said it would not judge. |
| `unavailable` | never gave an answer: its call failed, it timed out, or it was taken out of the run. |

Only an explicit endorsement is agreement. A reply that raises nothing is `silent`, not `agreed`: the room does not read approval into the absence of complaint.

## When an agreement does not count

**A reviewer that agrees while its own check is failing has contradicted itself.** If a reviewer runs a command, the command exits non-zero, and the same reply says it agrees, the room believes the command. The agreement is discarded and treated as an objection, the lead is told which command failed, and the receipt counts the reviewer under `contradicted`. That alone makes the grade `failed`.

**A person can ask that reviewers check before agreeing.** With that setting on, an agreement from a reviewer that ran nothing and opened nothing is not accepted as agreement.

## When a failed check stops counting

A check that failed is not held against the work for ever. There are two ways it stops counting as failing, and they are recorded differently.

- **Resolved.** The check failed, the work changed, and the check then passed. It is counted in `failed` and in `resolved`, and not in `failingNow`. This is the room working as intended: a mistake caught and fixed.
- **Withdrawn.** The check failed because the check itself was wrong, for example a test that counted the wrong thing. The room accepts this only on evidence it can see without reading anyone's reasoning: the same reviewer that ran the failing check later agrees, no file has changed in between, and that agreement is its last word. One reviewer's agreement never withdraws another reviewer's check.

A failing check whose reviewer never comes round stays failing, whatever the other seats say.

## The verdict

The verdict is worked out once, from the stances, and every place the result is shown uses the same one.

| Outcome | When |
|---|---|
| `agreed` | Every reviewer agreed. |
| `agreed`, with seats named as missing | Every reviewer that answered agreed, no check is still failing, and the only reviewers not agreeing are ones that could not answer at all. |
| `majority` | More than half of all reviewers agreed, and the above does not hold. |
| `none` | Half or fewer agreed. A tie is not a majority. |

Three things follow from this.

- **A seat that could not answer is not a seat that disagreed.** A provider outage should not turn sound, checked work into "no agreement". But a missing seat is never hidden: it is named in `holdouts` in every case, and it is left out of the count only when the outcome is `agreed`.
- **A missing seat cannot be used to pass failing work.** If any check is still failing, agreement among the seats that answered is not enough.
- **The room may record less agreement than the stances allow, never more.** It withholds `agreed` when it has a reason of its own, such as a run that the person stopped part-way.

Work that waits on the room's agreement goes ahead only on `agreed`, or on the person's own decision. It never goes ahead on a majority.

## After agreement

A person can ask for the answer to be tested once more after the room agrees. When that is on and the run changed files, the project's proven checks are run again on the final version. A proven check is one that has caught a real mistake in that project before; a test that has never failed has not shown it can catch anything.

If one of them fails, the grade is `failed`, and that outranks the agreement: the receipt says the answer was found wrong after everyone agreed.

## The grade

The verdict says how the reviewers ended. The grade says how well the result was checked, and it is worked out from the counts alone by the six rules in [SPEC.md](SPEC.md#grade), first match first:

1. `failed`: a check is still failing, or a reviewer contradicted itself.
2. `verified`: commands were run, and every reviewer that answered ran some.
3. `partial`: commands were run, by some reviewers only.
4. `reviewed`: nothing was run and no file was changed. A question was answered and read.
5. `not-visible`: nothing was run where it could be seen, and every reviewer worked out of view.
6. `unverified`: none of the above.

So a run can be `agreed` and `unverified` at once: everyone said yes and nobody ran anything. The room shows both, and it is the grade that tells a reader how much the agreement is worth.

Some reviewers work inside a tool whose commands the room cannot observe. Such a reviewer is not counted as having run nothing, and it is not counted as having checked: it is counted as not visible, and the receipt says so.

## What the room says it did not do

Every receipt carries `gaps`: plain statements of what was not verified, such as work checked only on the machine it was built on, or a reviewer that could not answer. Gaps are listed when everyone agreed as well as when they did not.

## What none of this proves

- **Agreement is not correctness.** Models can share a mistake, and several of them agreeing on it does not make it right. This is why the grade is separate from the verdict, and why a failing command outranks any number of endorsements.
- **A passing check proves that command exited 0.** It does not prove the command was the right one to run.
- **A receipt records what the room observed.** The room is the producer of its own receipt. A signature shows the receipt was not changed afterwards; it does not show the run happened as described. [SPEC.md](SPEC.md#what-a-verifier-cannot-tell-you) says what a verifier can and cannot tell you.

## What this page leaves out

The instructions the seats are given, how seats and models are chosen, and how the work is scheduled are not described here. They change often, and none of them alters what a stance, a verdict or a grade means.
