# CLAUDE.md

## Project Overview

This project is an ambient AI desktop companion.

The goal is NOT to build:

* a chatbot
* an AI wrapper
* a productivity dashboard
* “ChatGPT for X”

The goal is to build:

> a behavior-aware computing companion

The system quietly observes user context locally and occasionally provides meaningful interventions.

Think:

* Jarvis
* R2-D2
* ambient intelligence
* contextual operating system

NOT:

* assistant spam
* constant notifications
* AI-generated fluff

The product should feel:

* alive
* calm
* aware
* subtle
* cinematic
* trustworthy

---

# Core Product Principles

## 1. Presence > Chat

The AI should feel present even when silent.

Avoid:

* excessive dialogue
* long AI paragraphs
* “How can I help?”
* chatbot-style interactions

Prefer:

* short observations
* subtle interventions
* awareness
* environmental intelligence

---

## 2. Local-First

User trust is critical.

By default:

* data stays local
* processing stays local
* memory stays local

Avoid cloud dependencies whenever possible.

The user should feel:

> “this belongs to me”

NOT:

> “this is spying on me”

---

## 3. Behavioral Intelligence > Prompt Intelligence

The core innovation is NOT LLM output quality.

The core innovation is:

* context awareness
* timing
* memory
* behavior understanding
* interruption quality

The product succeeds if interventions feel:

* timely
* useful
* human
* surprisingly accurate

The product fails if interventions feel:

* random
* annoying
* corporate
* productivity-obsessed

---

# Tech Stack

## Frontend

* React
* TypeScript
* Next.js Pages Router

## Desktop Wrapper

Initially:

* Electron

Possible future migration:

* Tauri

---

# Architecture

## Main Systems

### 1. Activity Tracking

Tracks:

* active applications
* active window titles
* scrolling patterns
* idle behavior
* typing bursts
* app switching
* focus duration

The system should observe behavior at the OS level whenever possible instead of relying on browser integrations.

### 2. Memory Engine

Stores:

* interests
* recurring behaviors
* projects
* habits
* timelines
* summarized sessions

### 3. Intervention Engine

Determines:

* when to interrupt
* when to remain silent
* relevance/confidence thresholds

### 4. Local AI Layer

Used for:

* summarization
* memory synthesis
* lightweight reasoning
* contextual suggestions

NOT:

* endless chatting

---

# Coding Principles

## Keep Systems Explainable

Avoid “magic” behavior.

Interventions should be explainable via:

* heuristics
* observable behavior
* memory retrieval

The system should not feel unpredictable.

---

## Prefer Simple Heuristics First

DO NOT prematurely over-engineer with AI.

Bad:

* complex agent systems
* multi-agent orchestration
* autonomous loops

Good:

* deterministic rules
* lightweight classifiers
* behavioral thresholds

Example:

* user scrolls YouTube for 15 mins without interaction
* likely bored
* trigger recommendation

Simple > fake intelligence.

---

## Avoid AI Slop

Never add:

* fake automation
* unnecessary AI summaries
* meaningless “insights”
* generic motivational text

Every intervention must:

* save time
* increase awareness
* feel surprisingly relevant

---

# UI Principles

## Minimal Interface

The UI should feel:

* ambient
* lightweight
* alive

Avoid:

* dashboards
* enterprise layouts
* dense controls
* clutter

Prefer:

* floating orb
* subtle overlays
* motion
* glow
* spatial feeling

---

## Motion Matters

Motion is part of the personality.

Animations should feel:

* intentional
* soft
* responsive
* emotionally expressive

Avoid:

* gimmicky animations
* excessive motion
* gaming UI overload

---

# Memory System

## Source of Truth

Use:

* local markdown files
* Obsidian-compatible vault structure
* SQLite metadata index

The memory system should remain:

* inspectable
* editable
* portable

User ownership is critical.

---

## Memory Categories

Examples:

* interests
* people
* coding projects
* recurring websites
* goals
* habits
* learning topics

---

# Intervention Rules

## Default State = Silence

The AI should mostly observe.

Target:

* 95% silent
* 5% interventions

---

## Interventions Must Earn Attention

Good interventions:

* highly contextual
* short
* actionable
* emotionally intelligent

Bad interventions:

* generic
* repetitive
* productivity spam
* constant optimization advice

---

# Product Direction

This product should feel closer to:

* sci-fi operating systems
* companion devices
* ambient computing

NOT:

* SaaS
* copilots
* workflow automation

The emotional experience matters as much as functionality.

---

# What Success Looks Like

Users should say:

> “it feels alive”

NOT:

> “it has a lot of AI features”

---

# Long-Term Vision

Potential future directions:

* physical desk orb
* expressive hardware companion
* spatial audio
* local voice interaction
* proactive memory graph
* environmental awareness

But:

* software experience comes first
* behavior quality comes first
* trust comes first

---

# Development Priorities

## Phase 1

* OS-level activity tracking
* local memory system
* intervention engine
* floating UI
* contextual awareness

## Phase 2

* memory synthesis
* semantic retrieval
* local LLM integration
* personalization

## Phase 3

* hardware companion
* voice
* emotional expression
* multi-device awareness

---

# Important Constraints

DO NOT:

* overcomplicate architecture
* add agent buzzwords
* build unnecessary abstractions
* chase AGI fantasies

Focus on:

* responsiveness
* timing
* emotional believability
* usefulness
* atmosphere

---

# Design Inspiration

Emotional references:

* Jarvis
* R2-D2
* Her
* Joi (Blade Runner 2049)
* Cortana (Halo, not Microsoft)
* BD-1

Product references:

* Teenage Engineering
* Nothing
* Apple
* Rabbit R1 aesthetic direction
* Humane ambitions (but better execution)

---

# Final Rule

If a feature feels:

* corporate
* productivity-maxxing
* buzzword-heavy
* “AI SaaS”

…it is probably wrong.

If it feels:

* calm
* magical
* aware
* ambient
* emotionally believable

…it is probably right.
