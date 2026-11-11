# Reporting a security problem

Email support@gpulogy.com. Please do not open a public issue for a security problem.

Say what you found, how to reproduce it, and which version or commit you tested. You will get a reply within five working days.

## What counts here

- A receipt the verifier accepts although it breaks a rule in SPEC.md.
- A file that makes the verifier hang, crash or read or write anything other than the receipt it was given.
- A way to change a receipt without its digest changing.

## What does not

A digest is not a signature. Anyone who edits a receipt can retake its digest, and the specification says so. That is a known limit of version 0.1, not a vulnerability.
