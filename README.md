# HTML to Video Renderer

Render click-driven HTML animations to MP4 videos, timed to voiceover captions from SRT files. Built for workflows where you have dozens of animation segments that need to be rendered and placed on a video editing timeline in sync with a voiceover.

## Requirements

- **Node.js 18+** (that's it — Puppeteer bundles Chromium, ffmpeg is bundled via npm)

## Setup

```bash
git clone <repo-url>
cd html-to-video
npm install
npm start
```

Open **http://localhost:3847** in your browser.

## Quick Start

### 1. Import a Project

Click **Import Project** in the sidebar and enter the path to a project folder. The folder should contain numbered segment subfolders, each with HTML animation variants and an optional `.txt` script:

```
CreatorLuck_001/
├── SEGMENT_0001/
│   ├── script.txt           # voiceover script for this segment
│   ├── Option 1.html        # animation variant 1
│   ├── Option 2.html        # animation variant 2
│   └── Option 3.html        # animation variant 3
├── SEGMENT_0002/
│   ├── script.txt
│   ├── Option 1.html
│   └── ...
```

The importer copies all HTML files into the app and creates a project with segment metadata.

### 2. Upload the SRT File

Click **Upload SRT** in the project banner. The app matches each segment's `.txt` script text against the SRT captions using fuzzy text matching and assigns time ranges.

After matching, you'll see each segment in the sidebar with its time range and a confidence score (e.g. `0:17 - 0:34  92%`).

### 3. Fix Wrong Matches (SRT Timeline)

Click the **SRT Timeline** tab on the right panel to see every SRT cue with segment assignments overlaid.

If a segment is matched to the wrong position:
1. **Drag** the segment header from the left sidebar
2. **Drop** it onto the correct SRT cue in the timeline
3. The app rematches that segment and updates all its variant timing files

Green-highlighted cues mark where segments currently start. Segment badges show ownership.

### 4. Analyze All

Click **Analyze All** in the pipeline panel. This runs Puppeteer on each segment's Option 1 to detect the "beats" (click-driven animation steps), then clones the analysis to Option 2 and Option 3.

Progress is shown in real-time. Only Option 1 is analyzed per segment (since all variants have the same beat structure), saving ~2/3 of the time.

After analysis, beat times are refined by re-matching the detected text against the segment's specific SRT cues for more accurate timing.

### 5. Render All

Click **Render All (Option 1)** to render every first-variant segment sequentially. Or click **Render All Variants** for all options.

Renders process one at a time to avoid overloading the system. Progress is shown in real-time via the pipeline progress bar.

### 6. Import into Your Editor

Output files are in `output/` with names like:

```
001_SEGMENT_0001_Option1_@00m12s500.mp4
002_SEGMENT_0002_Option1_@00m35s200.mp4
003_SEGMENT_0003_Option1_@01m02s800.mp4
```

- **001, 002, 003...** — sequence number (sorted by timeline position)
- **@00m12s500** — the clip starts at 0:12.500 on the master timeline

Drop all files into your editor — they're already in the right order and the filename tells you exactly where each clip goes.

## Working with Individual Files

You don't need a full project to use the app. You can also:

- **Upload** individual HTML files via the `+ Upload` button
- **Click a file** to preview it — the app auto-analyzes beats on first select
- **Set timing manually** in the Beat Timing section (comma-separated seconds)
- **Upload an SRT** per file in the SRT Upload tab for automatic beat-to-cue mapping
- **Render** a single file or check multiple variants to render them together

## How It Works

### Beat Detection
Each HTML file is a click-driven presentation. Puppeteer loads the file, clicks through it, and detects each visual state change (a "beat"). It captures thumbnails and records what text is revealed at each step.

### SRT Matching
The app uses fuzzy text matching to align beats (or segment scripts) with SRT caption cues:
- **Per-file SRT**: matches beat text against cues using word overlap + bigram similarity
- **Project SRT**: matches segment `.txt` scripts against cue windows, then enforces monotonic ordering so segments stay in sequence

### Rendering
Puppeteer replays the animation at 30fps, clicking at the exact beat times. Static frames between transitions are reused (not re-captured) for speed. FFmpeg encodes the frames to H.264 MP4.

## Configuration

Edit `server/config.js` to change defaults:

| Setting | Default | Description |
|---------|---------|-------------|
| `PORT` | 3847 | Server port |
| `WIDTH` | 1920 | Video width (px) |
| `HEIGHT` | 1080 | Video height (px) |
| `FPS` | 30 | Framerate |
| `CRF` | 18 | Quality (0-51, lower = better) |

## Project Structure

```
html-to-video/
├── server/           # Express API + services
│   ├── index.js      # Server + WebSocket setup
│   ├── config.js     # Resolution, FPS, paths
│   ├── routes/       # API endpoints
│   └── services/     # Puppeteer analysis, rendering, SRT parsing
├── public/           # Frontend UI
│   ├── index.html
│   ├── css/
│   └── js/
├── input/            # HTML files to render (auto-created)
├── output/           # Rendered MP4s (auto-created)
└── data/             # Analysis cache, timing, project metadata (auto-created)
```

## Troubleshooting

**"Port 3847 already in use"** — Kill the old process: `lsof -ti:3847 | xargs kill -9`

**Analysis detects wrong beat count** — Click "Re-analyze" on the file. If the HTML uses non-standard click targets, the analyzer tries `#stage`, `#presentation`, `#app`, `.slides`, then `body`.

**SRT matching is off for a segment** — Use the SRT Timeline panel to drag the segment to the correct cue. This updates timing for all variants.

**Render is slow** — Renders run at ~2-5x realtime depending on animation complexity. The app processes one render at a time to stay stable. Each segment is typically 5-20 seconds of video.
