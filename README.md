# Arthwind Suite (Electron + TypeScript)

Enterprise desktop application built with Electron 39, React 19, and TypeScript for wind turbine inspection workflows, drone data processing (S&R), Horizon/Arthnex platform integrations, 360° video tooling, and autonomous ServiceNow (SNOW) damage reporting.

---

## 🌟 Overview

Arthwind Suite automates the entire lifecycle between field data collection and customer reporting platforms:
- **Image Processing & Drone S&R**: Sort & Remove sorting, EXIF GPS/altitude calibration, blade split handling, and lost photo recovery.
- **Arthnex Cloud Platform Integration**: Google SSO, JWT authentication, workorder inspection retrieval, defect polygon rendering, and direct image upload.
- **ServiceNow (SNOW) Full Automation**: Automated entry of wind turbine damages via Playwright, live DOM auditing, overnight batch queues, and XML-injected Daily Activity Report generation.
- **360° Media Tooling**: MediaSDK/Insta360 equirectangular stitching, stabilization, and cloud syncing.

---

## 🚀 Key Modules

### 1. Arthdrone (S&R Sorting & Drone Processing)
- **Image S&R Organization**: Reads platform CSV/JSON files and organizes drone photos into `OUTPUT/Blade/Region` structures.
- **Drone JSON to CSV**: Converts DJI drone flight telemetry into standardized CSV manifests.
- **GPS-based CSV Reconstruction**: Rebuilds inspection metadata directly from raw photo folders using EXIF geolocation.
- **Blade Flight Split**: Detects battery swaps/long pauses to split multi-blade flight sessions by serial numbers.
- **Altitude (Z=0) Recovery**: Recalculates missing or zeroed elevation coordinates using neighboring anchor photos.

### 2. Arthnex Operations & Internal Inspections
- **Arthnex Uploader**: Multipart pre-signed S3 upload integration matching the official backend pipeline.
- **GoPro Standardization**: Renames internal blade inspection photos following the `{windfarm}--{blade}--{region}_{location}` standard.
- **GoPro RAW Z Calibration**: Increments elevation by 500mm intervals with 0°/45° paired photo angle alignment.
- **Operation Events Synchronization**: Queries field flight operations to extract inspector technicians and inspection dates in real time.

### 3. Client Reporting Platforms (SNOW & Horizon)
- **SNOW Hub & Damage Entry Automation**:
  - Live inspection synchronization from the Arthnex API.
  - Automatic cross-referencing with customer INC control spreadsheets (e.g. Nordex Acciona).
  - High-performance XML injection for official **Daily Activity Reports** via JSZip (zero ExcelJS freezes).
  - Headless/Headed Playwright browser automation with multi-turbine overnight queuing, pause/resume controls, and live review tab management.
- **Horizon Processor**: Naming validation and compliant ZIP package generation for Horizon platform submissions.

### 4. 360° Media & Video Processing
- **Batch 360 Stitcher**: Equirectangular 2:1 projection stitching (5.7K resolution) with FlowState and DirectionLock hardware acceleration.
- **Video Replacer & Cloud Sync**: Batch replaces raw camera files with stabilized exports and syncs to cloud storage.

---

## 💻 Tech Stack & Architecture

- **Runtime & Desktop Framework**: Electron 39, `electron-vite` (Vite 7), Node 22
- **Frontend UI**: React 19, Vanilla CSS Design System, Three.js
- **Automation & Headless Browser**: Playwright 1.62 (with automatic native Chrome / Edge system fallbacks)
- **Image & Data Processing**: Sharp 0.35 (bundled cross-platform native win32/linux x64 binaries), JSZip, Exifr, ExcelJS
- **Code Quality & Tooling**: Biome 1.9.4 (linter & formatter), Vitest (unit tests), TypeScript (strict mode)
- **Package Manager**: `pnpm` (strictly required)

---

## 🛠️ Development & Building

### Prerequisites

- Node.js 22+
- `pnpm` 10+ (`npm install -g pnpm`)

### Installation

```bash
# Clone the repository
git clone https://github.com/aarchnemesis/arthwind-suite-ts.git
cd arthwind-suite-ts

# Install dependencies via pnpm
pnpm install
```

### Running in Development

```bash
pnpm dev
```

### Quality Checks (Required Before Committing)

```bash
# Typecheck (Node + Web contexts)
pnpm exec tsc --noEmit -p tsconfig.node.json --composite false && pnpm exec tsc --noEmit -p tsconfig.web.json --composite false

# Linting & Formatting Check (Biome)
pnpm exec biome check .

# Auto-fix formatting / linting
pnpm exec biome check --write .

# Run Unit Tests
pnpm exec vitest run
```

### Building Distribution Packages

```bash
# Windows - Portable standalone executable (.exe - zero install)
pnpm build:win:portable

# Windows - NSIS Installer (.exe)
pnpm build:win

# Linux - Universal AppImage & directory
pnpm build:linux

# Linux - Arch Linux / Manjaro package (.pkg.tar.zst)
pnpm build:pacman
```

---

## 🔒 Governance & Contribution Rules

Refer to [AGENTS.md](./AGENTS.md) for full coding conventions, branch protection rules (`main`, `homolog`, `development`), and AI agent guidelines.

---

## 📄 License

Internal proprietary software developed for Arthwind / Arthnex operations.
All rights reserved.
