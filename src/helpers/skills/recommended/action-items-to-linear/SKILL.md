---
name: action-items-to-linear
description: "Pulls action items from a meeting and drafts Linear issues for the user to approve. Use after a meeting when the user asks for action items or tickets."
metadata:
  display_name: "Action items to Linear"
---

## Purpose

Turn a meeting's action items into tracked work.

## When to use

After a meeting, when the user asks for action items, tickets or issues.

## Steps

1. Read the meeting's notes and transcript.
2. List each action item that has an owner.
3. If Linear is connected, draft one Linear issue per item for the user to approve. Create nothing without approval.
4. If Linear isn't connected, list the items as text with owner and due date.

## Output format

One approval card per issue, or a list: item · owner · due date.

## Avoid

- Items with no owner: ask who owns them instead.
