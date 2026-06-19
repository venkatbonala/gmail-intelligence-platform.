-- Migration: separate natural-language Summary from the bulleted AI Overview.
--
-- Before this change, the `summary` columns held bullet-point overviews. Going forward:
--   summary      = natural-language prose summary (the assignment's "concise/thread summary" requirement)
--   ai_overview  = optional complementary extraction layer (key facts / actions as bullets)
--
-- Run once in the Supabase SQL editor (Project > SQL Editor > New query > Run).
-- Safe to run multiple times thanks to IF NOT EXISTS.

ALTER TABLE public.emails  ADD COLUMN IF NOT EXISTS ai_overview text;
ALTER TABLE public.threads ADD COLUMN IF NOT EXISTS ai_overview text;
