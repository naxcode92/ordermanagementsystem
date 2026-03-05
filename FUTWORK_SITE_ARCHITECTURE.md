# Futwork.ai — Site Architecture Plan

> Complete blueprint for rebuilding futwork.ai as a static marketing website.
> **This plan is a reference document.** The actual implementation should live in a separate repository (e.g., `futwork-site`).

---

## Table of Contents

1. [Overview](#overview)
2. [Templates vs. Unique Pages](#templates-vs-unique-pages)
3. [Full Site Map](#full-site-map)
4. [Shared Components](#shared-components)
5. [Tech Stack](#tech-stack)
6. [Project File Structure](#project-file-structure)
7. [Build Phases](#build-phases)
8. [Content Architecture (JSON CMS)](#content-architecture-json-cms)
9. [Component Specifications](#component-specifications)
10. [Deployment](#deployment)

---

## Overview

| Metric | Count |
|---|---|
| Total pages | ~17 |
| Unique templates needed | 9 |
| Shared components | 8 |
| CMS content files | ~10 JSON files |
| Estimated sessions | 6–10 |

---

## Templates vs. Unique Pages

The site has ~15 pages, but many share the same layout. All 6 solution pages (Logistics, E-commerce, etc.) use **one template** with different JSON content. Legal pages share another template. This is a CMS pattern: **one template + different content = many pages**.

In code terms, a template is an `.html` file with placeholder slots. A `components.js` script reads the corresponding `.json` content file and renders the page dynamically.

---

## Full Site Map

### Core Pages — Unique Layouts

| Page | Route | Type |
|---|---|---|
| Home (Landing Page) | `/` | UNIQUE |
| Pricing | `/pricing` | UNIQUE |
| Contact / Get in Touch | `/contact` | UNIQUE |
| About Us | `/about-us` | UNIQUE |
| Hall of Fame | `/hall-of-fame` | UNIQUE |
| Contact Centre AI Transformation | `/contact-center-ai-transformation` | UNIQUE |

### Solution Pages — 1 Template → 6 Pages

| Page | Route | Type |
|---|---|---|
| Logistics | `/solutions/logistics` | TEMPLATE |
| Consumer & E-commerce | `/solutions/ecommerce-d2c-voiceai` | TEMPLATE |
| Education | `/solutions/education` | TEMPLATE |
| Finance & Brokerage | `/solutions/bfsi-voice-ai` | TEMPLATE |
| Entertainment | `/solutions/entertainment` | TEMPLATE |
| International | `/solutions/international` | TEMPLATE |

### CMS-Driven Content — Dynamic Pages

| Page | Route | Type |
|---|---|---|
| Insights (Blog listing) | `/insights/insights` | CMS LIST |
| Individual Insight/Article | `/insights/[slug]` | CMS DETAIL |

### Legal / Utility Pages — Simple Text Template

| Page | Route | Type |
|---|---|---|
| Terms of Use | `/terms-of-use` | TEMPLATE |
| Privacy Policy | `/privacy-policy` | TEMPLATE |

---

## Shared Components

Build once, use everywhere. Each component is a reusable HTML/JS block loaded via `components.js`.

### 1. Navbar — `components/navbar.html`
- **Used on:** ALL PAGES
- Logo + Solutions dropdown + Resources dropdown + "Get in Touch" CTA button
- Hamburger menu on mobile
- Sticky on scroll

### 2. Footer — `components/footer.html`
- **Used on:** ALL PAGES
- Logo, newsletter signup, address, solution links, company links, contact details, social icons, copyright

### 3. Logo Marquee — `components/logo-marquee.html`
- **Used on:** HOME + SOLUTIONS
- Infinite scrolling strip of client logos (Shadowfax, BharatPe, Paytm, Stage, etc.)
- CSS `@keyframes` animation, no JS dependency

### 4. CTA Section — `components/cta-section.html`
- **Used on:** MOST PAGES
- "Let's make your support future ready" block with demo button
- Appears at the bottom of most pages before footer

### 5. Testimonial Carousel — `components/testimonials.html`
- **Used on:** HOME + SOLUTIONS
- Sliding cards with client quotes, photos, and company logos
- Arrow navigation, auto-play with pause on hover

### 6. Case Study Card
- **Used on:** HOME + SOLUTIONS
- Image + client logo + stat headline + description + "Listen to call" button
- Rendered inline (not a separate component file)

### 7. Feature Card
- **Used on:** HOME
- Icon + title + description in a dark card with subtle border
- Used in the features grid section

### 8. Process Steps
- **Used on:** HOME + SOLUTIONS
- Numbered steps (01→05) with titles, descriptions, and green arrow connectors

---

## Tech Stack

| Tool | Purpose | Why |
|---|---|---|
| **HTML + CSS + JS** | Foundation | Beginner-friendly, no build tools needed |
| **Tailwind CSS (CDN)** | Styling framework | Utility-first, fast styling, matches Webflow approach |
| **JSON content files** | CMS layer | Simplest CMS — edit text without touching HTML |
| **GitHub Pages or Netlify** | Hosting | Free, fast, no server management |

### Tailwind CDN Setup

```html
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = {
    theme: {
      extend: {
        colors: {
          'futwork-green': '#00C853',
          'futwork-dark': '#0A0A0A',
          'futwork-gray': '#1A1A2E',
        }
      }
    }
  }
</script>
```

---

## Project File Structure

```
futwork-site/
├── index.html                          ← Homepage
├── pages/
│   ├── pricing.html
│   ├── contact.html
│   ├── about-us.html
│   ├── hall-of-fame.html
│   ├── contact-center-ai.html
│   ├── terms-of-use.html
│   ├── privacy-policy.html
│   └── solutions/
│       ├── template.html               ← One template for all solutions
│       ├── logistics.html
│       ├── ecommerce.html
│       ├── education.html
│       ├── finance.html
│       ├── entertainment.html
│       └── international.html
├── insights/
│   ├── index.html                      ← Blog listing (CMS-driven)
│   └── [article-slug].html
├── content/                            ← JSON CMS: edit these files to change content
│   ├── home.json
│   ├── pricing.json
│   ├── solutions/
│   │   ├── logistics.json
│   │   ├── ecommerce.json
│   │   ├── education.json
│   │   ├── finance.json
│   │   ├── entertainment.json
│   │   └── international.json
│   └── insights/
│       ├── article-1.json
│       └── article-2.json
├── components/                         ← Reusable building blocks
│   ├── navbar.html
│   ├── footer.html
│   ├── logo-marquee.html
│   ├── cta-section.html
│   └── testimonials.html
├── assets/
│   ├── css/
│   │   └── styles.css                  ← Global custom styles (beyond Tailwind)
│   ├── images/
│   │   ├── logo-dark.svg
│   │   ├── logos/                      ← Client logos
│   │   └── case-studies/
│   └── js/
│       ├── main.js                     ← Shared JS (nav toggle, animations)
│       └── components.js               ← Loads shared components into pages
└── README.md
```

### How `components.js` Works

```js
// components.js — loads reusable HTML components into pages
document.addEventListener('DOMContentLoaded', async () => {
  const components = document.querySelectorAll('[data-component]');
  for (const el of components) {
    const name = el.getAttribute('data-component');
    const res = await fetch(`/components/${name}.html`);
    if (res.ok) {
      el.innerHTML = await res.text();
    }
  }
});
```

Usage in any page:
```html
<div data-component="navbar"></div>
<!-- page content -->
<div data-component="cta-section"></div>
<div data-component="footer"></div>
```

---

## Build Phases

### Phase 1: Foundation & Homepage (~2–3 sessions)

**Goal:** Working site with homepage from day one.

- [ ] Initialize repo, set up file structure
- [ ] Configure Tailwind via CDN, create `styles.css` for custom overrides
- [ ] Build `components.js` (component loader)
- [ ] Build Navbar component (desktop + mobile hamburger)
- [ ] Build Footer component
- [ ] Build Homepage — all 13 sections:
  1. Hero section with CTA
  2. Logo marquee (client logos)
  3. Problem statement / value proposition
  4. Features grid (Feature Cards)
  5. How it works (Process Steps)
  6. Platform showcase
  7. Case studies section
  8. Testimonial carousel
  9. Stats / metrics bar
  10. Integration partners
  11. Industry solutions overview
  12. CTA section
  13. Newsletter / contact teaser
- [ ] Mobile responsive pass on all sections
- [ ] Test all pages across browsers

### Phase 2: Solution Pages — Template System (~1–2 sessions)

**Goal:** One template powering 6 solution pages via JSON content.

- [ ] Build `solutions/template.html` with placeholder slots
- [ ] Create JSON schema for solution content
- [ ] Write `solutions-renderer.js` to read JSON and populate template
- [ ] Create 6 JSON content files:
  - `logistics.json`
  - `ecommerce.json`
  - `education.json`
  - `finance.json`
  - `entertainment.json`
  - `international.json`
- [ ] Create 6 solution page HTML files (thin wrappers that load template + JSON)
- [ ] Test all 6 solution pages
- [ ] Add Logo Marquee and Testimonials to solution pages

### Phase 3: Remaining Pages (~2–3 sessions)

**Goal:** All pages complete.

- [ ] Pricing page (unique layout)
- [ ] Contact page with form (Netlify Forms or Formspree integration)
- [ ] About Us page (unique layout)
- [ ] Hall of Fame page (unique layout)
- [ ] Contact Centre AI Transformation page (unique layout)
- [ ] Insights listing page (reads from `content/insights/*.json`)
- [ ] Individual article page template
- [ ] Legal pages template (Terms of Use, Privacy Policy)
- [ ] 404 page

### Phase 4: Polish & Launch (~1–2 sessions)

**Goal:** Production-ready, deployed.

- [ ] Add scroll animations (Intersection Observer API)
- [ ] SEO meta tags on all pages (title, description, Open Graph, Twitter cards)
- [ ] Performance audit (image optimization, lazy loading, minification)
- [ ] Accessibility audit (ARIA labels, keyboard navigation, contrast)
- [ ] Set up CMS admin (Decap CMS or custom JSON editor)
- [ ] Configure hosting (GitHub Pages or Netlify)
- [ ] Set up custom domain
- [ ] Deploy to production
- [ ] Verify all routes and redirects

---

## Content Architecture (JSON CMS)

### Solution Page JSON Schema

```json
{
  "meta": {
    "title": "Logistics Voice AI Solutions | Futwork",
    "description": "AI-powered voice solutions for logistics companies",
    "slug": "logistics"
  },
  "hero": {
    "headline": "Voice AI for Logistics",
    "subheadline": "Automate delivery confirmations, returns, and customer support",
    "cta_text": "Book a Demo",
    "cta_link": "/contact",
    "hero_image": "/assets/images/solutions/logistics-hero.webp"
  },
  "pain_points": [
    {
      "icon": "phone-missed",
      "title": "Missed Deliveries",
      "description": "30% of first delivery attempts fail..."
    }
  ],
  "features": [
    {
      "icon": "check-circle",
      "title": "Automated Confirmation Calls",
      "description": "AI calls customers to confirm delivery windows..."
    }
  ],
  "process_steps": [
    {
      "step": 1,
      "title": "Integration",
      "description": "Connect your logistics platform via API..."
    }
  ],
  "case_studies": [
    {
      "client": "Shadowfax",
      "logo": "/assets/images/logos/shadowfax.svg",
      "image": "/assets/images/case-studies/shadowfax.webp",
      "stat": "40% fewer failed deliveries",
      "description": "How Shadowfax reduced missed deliveries...",
      "call_recording_url": "#"
    }
  ],
  "testimonials": [
    {
      "quote": "Futwork's AI transformed our delivery operations...",
      "name": "John Doe",
      "title": "VP Operations",
      "company": "Shadowfax",
      "photo": "/assets/images/testimonials/john.webp"
    }
  ],
  "logos": [
    "/assets/images/logos/shadowfax.svg",
    "/assets/images/logos/delhivery.svg"
  ]
}
```

### Insights Article JSON Schema

```json
{
  "meta": {
    "title": "How AI is Transforming Customer Support",
    "description": "A deep dive into AI-powered voice solutions...",
    "slug": "ai-transforming-customer-support",
    "date": "2026-02-15",
    "author": "Futwork Team",
    "category": "AI Insights",
    "featured_image": "/assets/images/insights/ai-support.webp"
  },
  "content": [
    {
      "type": "paragraph",
      "text": "Customer support is evolving rapidly..."
    },
    {
      "type": "heading",
      "level": 2,
      "text": "The Rise of Voice AI"
    },
    {
      "type": "image",
      "src": "/assets/images/insights/voice-ai-chart.webp",
      "alt": "Voice AI adoption chart"
    },
    {
      "type": "paragraph",
      "text": "According to recent studies..."
    }
  ]
}
```

---

## Component Specifications

### Navbar Behavior

```
Desktop:
┌──────────────────────────────────────────────────────────┐
│ [Logo]   Solutions ▾   Resources ▾   Pricing   [Get in Touch] │
└──────────────────────────────────────────────────────────┘

Mobile:
┌──────────────────────┐
│ [Logo]          [☰]  │
└──────────────────────┘
  ↓ (hamburger open)
┌──────────────────────┐
│ Solutions ▾          │
│ Resources ▾          │
│ Pricing              │
│ [Get in Touch]       │
└──────────────────────┘
```

- Solutions dropdown: links to all 6 solution pages
- Resources dropdown: links to Insights, Hall of Fame
- Sticky on scroll (add shadow on scroll)
- Active page indicator

### Logo Marquee

- Pure CSS infinite scroll animation
- Two copies of logo strip for seamless loop
- `animation: scroll 30s linear infinite`
- Pause on hover

### Testimonial Carousel

- CSS scroll-snap or JS-based sliding
- Auto-advance every 5 seconds
- Pause on hover
- Arrow buttons for manual navigation
- Dots indicator for current slide
- Touch/swipe support on mobile

---

## Deployment

### Option A: GitHub Pages

```bash
# In repo settings, set Pages source to main branch, / (root)
# Site will be available at https://naxcode92.github.io/futwork-site/
# Add custom domain in repo settings
```

### Option B: Netlify

```bash
# Connect repo to Netlify
# Build command: (none — static files)
# Publish directory: /
# Enable form handling for contact page
# Add custom domain
```

### Recommended: Netlify

- Built-in form handling (no backend needed for contact form)
- Deploy previews for PRs
- Free SSL
- Instant cache invalidation

---

## Notes

- **Images:** Use `.webp` format for all images. Provide `.png` fallbacks via `<picture>` element.
- **Fonts:** Load via Google Fonts or self-host for performance.
- **Analytics:** Add Google Analytics or Plausible snippet in footer component.
- **Favicon:** Include multiple sizes (16x16, 32x32, 180x180 for Apple Touch).
- **Sitemap:** Generate `sitemap.xml` listing all pages for SEO.
- **robots.txt:** Allow all crawlers, point to sitemap.
