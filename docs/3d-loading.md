# 3D loading and tab lifetime

- Auto mode still prefers a same-board assembly WRL/STEP when supplied. These projects load one assembly; projects without an assembly resolve individual footprint model references.
- Footprint references are grouped by exact path. Four loading jobs share at most two reusable STEP workers (one on devices reporting four or fewer CPU threads). Idle workers terminate after 30 seconds.
- Successful model data is cached in memory for the uploaded asset session, with a 128 MiB budget. Cache contains CPU data, not scene-owned GPU objects. Failed/cancelled work remains retryable. Refreshing or opening another project does not promise persistent cache reuse.
- The 3D tab mounts on first use and stays mounted across tab switches. Loading and camera state survive; hidden views stop their render loops. Project replacement releases the scene.
- PCB geometry appears before all models finish. Missing references are grouped by model path with affected references inside collapsed details.
- Exact Espressif KiCad third-party paths can resolve from the manufacturer's public model directory. Only model basenames are accepted; large files redirect to that fixed CORS-enabled origin rather than exceeding the hosting function's response body limit. Browser downloads remain bounded at 20 MiB.
- A missing official model is never substituted with a similarly named package. LabSight's LED_WS2812B-2020_PLCC4_2.0x2.0mm.step returned 404 during verification; supply the actual file with the project. ESP32-S31-WROOM-3_V1_1.STEP was downloaded and converted successfully (371 meshes, 50,052 triangles).

Regression coverage: pending-request deduplication, cache reuse after scene disposal, cancellation/retry, cache eviction, STEP worker reuse/concurrency/timeout, lazy tab mounting and retention, grouped failures, manufacturer route allowlisting and large-file redirect. Browser visual verification was blocked by the test environment's localhost access policy.
