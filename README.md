# World Travel Memories — automation repair

## Purpose

This repository is a sanitized, local record of the repair made to the existing Google Apps Script project named **World Travel Memories**. It does not create or replace that production project.

The included `Code.gs` is the repaired production source with the Google Drive root and excluded-folder IDs redacted. Script Properties, Buffer and Cloudinary credentials, Tracker data, file IDs, and posting history are deliberately not included.

## Confirmed diagnosis

The scheduler last completed its historical slot at 3:00 p.m. America/Bogota on 16 July 2026. At the next scheduled slot, it selected an oversized MP4. The former code requested a Drive blob before checking its size, which raised a maximum-file-size exception. Because the top-level scheduler did not catch the exception, it neither wrote a failed tracker row nor advanced safely; each five-minute check retried the same file.

## Repair

- Keeps every currently uploadable city folder in one rotation. Live inspection resolved **32** city folders.
- Completes one turn for every city before another city begins a new round.
- Selects unused supported media for the selected city first; only after that city is exhausted does it reuse media from that same city.
- Avoids the most recently posted file for a city whenever another file exists.
- Removes strict photo/video alternation from the live scheduler, so media type cannot block city rotation.
- Preserves the established 9:00 a.m., noon, 3:00 p.m., 6:00 p.m., and 9:00 p.m. America/Bogota schedule and uses the existing Drive folder name as the caption.
- Retains the pre-existing excluded folder and all historical posting records.
- Rejects files over the Apps Script upload-safe size gate before materializing their blobs.
- Records a `Failed` tracker row for a Cloudinary or Buffer failure and leaves the slot incomplete so a later five-minute check can recover.

## Verification performed

- Inspected executions after 16 July 2026, 3:00 p.m. America/Bogota; the historical failure was the oversized-video error.
- Confirmed there is exactly one active `worldTravelScheduleCheck` trigger on a five-minute timer.
- Confirmed Script Properties remained present without copying their values.
- Checked the automation log's Config and Posts tabs before and after the repair.
- Ran safe Buffer draft tests for one photo and one video. Both Buffer previews rendered successfully.
- Confirmed the repaired scheduled checks completed and live automation is enabled. The completed 3:00 p.m. slot now reflects 18 July 2026.

## Local repository note

The workstation used for this repair has no Git executable installed. The `.git` metadata in this folder is initialized as a standard empty working-tree repository so these files can be opened, tracked, and committed immediately from any Git client, without installing or changing anything on the production Apps Script project.
