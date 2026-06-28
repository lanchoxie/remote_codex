# History Import Filtering Design

## Goal

Improve the `Others` history import dialog so users can find and attach conversations without scanning the full session list. The import should remain an attachment workflow: selecting conversations attaches markdown history and optional zip bundles, and must not send messages or change session runtime state.

## Current Behavior

`Others` currently builds candidates from `state.sessions`, excludes only the currently selected session, and sorts by updated time. This ignores collections, creates a long global list, and does not expose sorting by created time or message count inside the dialog.

## Proposed Behavior

When opening `Others`, the dialog defaults to the currently selected collection. Users can select multiple collections from the dialog toolbar. Trash is excluded from the collection filter by default so discarded conversations do not reappear in imports.

If the same conversation exists in multiple selected collections, it appears once. The row shows the collection names it belongs to. Selection remains conversation-based rather than collection-item-based, so selecting the row imports that conversation only once.

The dialog includes a local search box and sort controls:

- Updated time, descending by default
- Created time
- Message count
- Ascending/descending toggle

The existing per-conversation import options remain:

- Thinking
- Images
- Files

## Data Flow

The dialog stores its own filter state in `state.historyImportDialog`:

- selected collection ids
- search query
- sort key
- sort direction
- selected conversation keys
- per-conversation import options

Candidate generation uses existing conversation-group helpers where possible:

1. Read selected collections.
2. Build conversation groups for each collection.
3. Merge groups by `hostId + conversationKey`.
4. Attach `collectionNames` metadata to the merged row.
5. Exclude the currently selected conversation.
6. Apply search and sort.

The import action continues to call `attachSessionHistory()` for each selected row's preferred session.

## UI

The existing modal gets a compact toolbar above "Select all visible conversations":

- Collection chips or checkboxes for user collections
- Search input
- Sort select
- Direction button

Each result row keeps its current title, host/session id, cwd, and import option checkboxes. It also shows:

- Collection tags
- Created time
- Updated time
- Message count

The empty state explains whether there are no conversations in the selected collections or no matches for the current search.

## Error Handling

If no collections are selected, the dialog shows no candidates and disables select-all/confirm.

If a selected conversation fails to export, the existing partial-failure alert remains. Successful imports still attach.

Trash conversations are not included unless a future explicit "include Trash" control is added.

## Testing

Add a focused regression test for the import dialog:

- Default scope is the current collection.
- Multiple selected collections merge candidates and dedupe conversations.
- Rows expose collection names.
- Sorting works for updated time, created time, and message count.
- Search filters visible candidates.
- Select-all selects only visible filtered candidates.
- Import still calls attachment logic, not message send/runtime queue logic.

