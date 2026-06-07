<div align="center">

# Twizzy Auto Spa — Website

Marketing website for **Twizzy Auto Spa**, a fully mobile auto detailing service
in the Greater Toronto Area offering detailing packages, paint correction, and
ceramic coatings.

A single-page, dependency-free static site built with Tailwind CSS and vanilla JavaScript.

[![Live Site](https://img.shields.io/badge/live-site-22c55e?style=flat-square)](https://twizzyautospa.setmore.com/shayan)
![HTML5](https://img.shields.io/badge/HTML5-e34f26?style=flat-square&logo=html5&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38bdf8?style=flat-square&logo=tailwindcss&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-f7df1e?style=flat-square&logo=javascript&logoColor=black)
![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)

</div>

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Adding Your Assets](#adding-your-assets)
- [Customization](#customization)
- [Deployment](#deployment)
- [Browser Support](#browser-support)
- [License](#license)

---

## Overview

This repository contains the source for the Twizzy Auto Spa marketing site. The
entire site is a single `index.html` file with no build step, package manager, or
backend — making it trivial to host on any static platform (GitHub Pages, Netlify,
Vercel, Cloudflare Pages, etc.).

The site presents service packages and pricing, explains paint correction and
ceramic coating offerings, showcases a photo gallery, displays customer reviews,
and drives bookings to an external [Setmore](https://www.setmore.com/) scheduling page.

---

## Features

- **Responsive, mobile-first layout** — adapts cleanly from phones to desktops
- **Service package cards** — Factory Reset, Showroom Ready, and Platinum Protection with pricing
- **Expandable detail cards** — collapsible Ceramic Coating and Paint Correction sections
- **Touch-enabled image carousel** — swipe gestures, prev/next controls, and dot navigation
- **Scroll-reveal animations** — sections fade in on scroll via `IntersectionObserver`
- **Sticky navigation** — with a slide-down mobile menu
- **Before/after & certification galleries** — with graceful placeholders when images are missing
- **Quote request form** — client-side validation (no backend; see [Customization](#customization))
- **Booking & click-to-call CTAs** throughout

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Markup | HTML5 |
| Styling | [Tailwind CSS](https://tailwindcss.com/) via CDN |
| Fonts | [Outfit](https://fonts.google.com/specimen/Outfit) via Google Fonts |
| Scripting | Vanilla JavaScript (no frameworks, no dependencies) |

No build tooling is required. Tailwind is loaded through its CDN with an inline
`tailwind.config` for the custom theme (brand red, gold accents, dark "ink" palette).

---

## Getting Started

### Prerequisites

A modern web browser. Optionally, Python or Node.js to run a local server (recommended
so that relative `/assets` paths resolve correctly).

### Run locally

Clone the repository:

```bash
git clone https://github.com/<your-username>/twizzy-auto-spa.git
cd twizzy-auto-spa
```

Then serve it with any static server:

```bash
# Python 3
python -m http.server 8000

# or Node.js
npx serve
```

Open <http://localhost:8000> in your browser.

> You can also just double-click `index.html`, but a local server is recommended
> so images and other assets load correctly.

---

## Project Structure

```
twizzy-auto-spa/
├── index.html              # Entire site: markup, inline Tailwind config, and scripts
├── README.md
└── assets/
    ├── porsche.jpeg        # Hero image
    ├── before.jpeg         # Ceramic before
    ├── after.jpeg          # Ceramic after
    ├── igl-shayan.jpg      # IGL certification
    ├── igl-phoenix.jpg     # IGL certification
    ├── 1.jpg … 14.jpg      # Gallery carousel images
    └── logos/
        └── logo-1.png … logo-6.png   # Partner / product brand logos
```

---

## Adding Your Assets

Image paths are referenced relative to the site root. Drop files into `/assets/`
using the exact filenames above. Until the files exist, the gallery and
before/after sections display labeled placeholders, and the logo grid shows
broken-image icons.

Recommended image sizes:

| Asset | Suggested width |
|-------|-----------------|
| Hero (`porsche.jpeg`) | ~1600px |
| Before / after | ~1200px |
| Gallery (`1.jpg`–`14.jpg`) | ~1200px |
| Logos | transparent PNG, ~240px wide |

---

## Customization

Common edits, all within `index.html`:

- **Theme colors** — edit the `tailwind.config` block near the top (`<head>`).
  The brand palette, `gold`, and dark `ink`/`paper` tones are defined there.
- **Pricing & packages** — update the package cards in the `#services` section.
- **Contact info** — phone number (`tel:` links), hours (footer), and the
  booking URL (`https://twizzyautospa.setmore.com/shayan`) appear in multiple
  places; search and replace each.
- **Reviews** — edit the `<figure>` blocks in the `#reviews` section.
- **Quote form** — the form in `#booking` currently only resets and shows an
  `alert()` on submit. To actually receive submissions, wire it up to a service
  such as [Formspree](https://formspree.io/), [Getform](https://getform.io/), or
  your own endpoint by setting the form `action`/`method` and removing the
  inline `onsubmit` handler.

---

## Deployment

Because this is a static site, deployment is simple. A few options:

### GitHub Pages

1. Push the repository to GitHub.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*,
   choose your branch (e.g. `main`) and the `/ (root)` folder.
4. Save — your site publishes at `https://<your-username>.github.io/twizzy-auto-spa/`.

### Netlify / Vercel / Cloudflare Pages

Connect the repo and deploy with default settings. There is **no build command**
and the **publish/output directory is the project root**.

---

## Browser Support

Works in all modern evergreen browsers (Chrome, Edge, Firefox, Safari). Relies on
`IntersectionObserver` and CSS features that are well-supported across current
browser versions.

---

## License

Released under the [MIT License](LICENSE).

The Twizzy Auto Spa name, logo, branding, and photography are property of Twizzy
Auto Spa and are **not** covered by the MIT license.

---

<div align="center">

**Twizzy Auto Spa** · Detailing · Paint Correction · Ceramic Coatings
Serving the GTA & surrounding areas · [(647) 883-0113](tel:+16478830113)

</div>
