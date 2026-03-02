# EEG Dashboard · USZ Epilepsy Unit

A browser-based dashboard for tracking EEG reports by assistant doctors during their rotation at the Epilepsy & EEG Unit, University Hospital Zurich.

## Features

- **Upload** an Excel export from the MS Access EEG database (`.xlsx`)
- **Individual Doctor view** — monthly bar chart, projection to end of rotation, traffic-light status (on track / behind / at risk)
- **Department view** — sortable overview table + unit monthly summary chart
- **Adjustable period** — 6 months (100% FTE), 12 months (50% FTE), or custom
- **Adjustable target** — defaults to 800 EEGs (Swiss board exam requirement)
- **CSV export** of the department overview table
- **Print support** — optimised print layout via browser print dialog
- **Offline-friendly** — parsed datasets persist in `localStorage`; no server required

## Expected Excel format

| Datum | AA | OA |
|-------|----|----|
| 18.09.2023 | Name\nRole | Name\nRole |

- **Datum** — date column (any date format Excel recognises)
- **AA / OA** — doctor slots; each cell contains `Name` + newline + `Role title`
- Multiple people per cell are separated by a blank line
- The columns may be swapped — role classification uses keywords, not column position

Role keywords recognised:
- **Assistant doctors**: `Assistenzarzt`, `Assistenzärztin`
- **Consultants**: `Oberarzt/in`, `Chefarzt/in`, `Leitender Oberarzt`, `Facharzt/in`

Academic prefixes (`Dr. med.`, `PD Dr.`, `Prof.`, `sc.nat.`) and post-nominals (`PhD`, `FEBN`, `MSc ETH`) are stripped automatically during name normalisation.

## Usage

1. Open `index.html` in a modern browser (Chrome, Firefox, Safari, Edge)
2. Drag and drop your `.xlsx` file onto the upload zone, or click **Choose File**
3. Select a doctor from the sidebar to view their individual chart
4. Switch to the **Department** tab for the unit overview
5. Adjust the rotation period and target using the controls in the doctor detail panel
6. Click **Export CSV** to download the department table, or **Print** for a printout

## Deployment (GitHub Pages)

```bash
git init
git add .
git commit -m "Initial release — EEG Dashboard"
git remote add origin https://github.com/mgalovic/eeg_dashboard.git
git branch -M main
git push -u origin main
```

Then in the GitHub repository settings → Pages → Source: **main branch / root**.

The dashboard will be live at: `https://mgalovic.github.io/eeg_dashboard/`

## Local development

No build step required. Open `index.html` directly in a browser, or serve with any static file server:

```bash
# Python
python3 -m http.server 8080

# Node (npx)
npx serve .
```

## Libraries (CDN, no installation)

- [SheetJS](https://sheetjs.com/) `xlsx-0.20.3` — Excel parsing
- [Chart.js](https://www.chartjs.org/) `4.4.4` — charting

## Privacy

All data processing happens entirely in the browser. No data is sent to any server. Parsed datasets are stored only in your browser's `localStorage`.
