# IndustryProof UI prototype

Clickable prototype of the product around the 3D assessment: the company side that
builds and reviews assessments, the candidate side that takes one by video call, and a
public page that verifies a result's credential. It runs on sample data.

## Run it

Open `prototype/index.html` in a browser, or serve the repo (`npm start`) and go to
http://localhost:5173/prototype/. Keep `index.html` and the two `scene_*.jpg` files in
the same folder.

## What's in it

Use the **Company / Candidate / Public** switch in the top right.

| Side | Screens |
| --- | --- |
| Company | Overview → Build an assessment (role and site, scenario, review drafts, test and approve, invite) → Review results (checks plus a 1-5 competency profile with evidence) |
| Candidate | Briefing → Check-in (camera and consent) → Video call with the AI shift lead → Submitted (a shareable skills badge on a pass, a private skills report otherwise) |
| Public | Verify a credential by ID or a shared `/badge/<id>` link, and edit the signed record to see a tampered one fail |

## Notes for wiring it up

- The call on the candidate side plays a scripted sample. The voice agent replaces it.
- Sample results live in `CANDIDATES` near the top of the script, in the same shape the
  scoring step should return.
- Credentials are pre-signed with a demo key (ECDSA P-256) and the page holds only the
  public key. In the real build, signing happens on the server; the private key never
  goes to the browser.
- The camera can't turn on inside the claude.ai preview, but works when served normally.
