## ADDED Requirements

### Requirement: Collection Tree Sidebar
The authenticated app shell SHALL render a left-nav tree of the user's collections under an "All Pages" root.

#### Scenario: Tree structure
- **WHEN** the app layout mounts
- **THEN** it MUST call `GET /api/v1/library/collections` (with no `parent_id`) once per session and build a tree from the returned flat list using `parent_id` pointers
- **AND** each node MUST show the collection colour dot, name, and `page_count`
- **AND** nodes MUST be expandable/collapsible with state persisted in `localStorage` (collapse-state keys only, not collection data)

#### Scenario: Default selection
- **WHEN** no collection is selected (`/app` root)
- **THEN** "All Pages" MUST be highlighted and the dashboard lists every page
- **AND** when a collection is selected, the dashboard MUST list only pages in that collection

### Requirement: Create Collection
The sidebar SHALL expose a "New collection" action that opens a dialog creating a collection at the currently-selected parent (or root).

#### Scenario: Create at root
- **WHEN** the user clicks "New collection" with "All Pages" selected, enters a name and a colour
- **THEN** the app MUST call `POST /api/v1/library/collections` with `{ name, color }` and no `parent_id`
- **AND** optimistically insert the new node at the root

#### Scenario: Create nested
- **WHEN** the user right-clicks an existing collection and chooses "Add sub-collection"
- **THEN** the dialog MUST pre-fill `parent_id` with the right-clicked collection's id
- **AND** the created node MUST appear as a child in the tree

### Requirement: Rename & Recolour & Delete
Collection nodes SHALL support rename, recolour, and delete via a context menu.

#### Scenario: Rename
- **WHEN** the user double-clicks a collection name (or chooses Rename)
- **THEN** the name turns into an inline input; on Enter the app MUST call `PATCH /api/v1/library/collections/{id}` with the new `name`
- **AND** optimistically update the tree; roll back on error

#### Scenario: Recolour
- **WHEN** the user picks a new colour from the context menu
- **THEN** `PATCH /api/v1/library/collections/{id}` MUST be called with `{ color }`
- **AND** the tree dot MUST update immediately

#### Scenario: Delete
- **WHEN** the user clicks Delete and confirms
- **THEN** `DELETE /api/v1/library/collections/{id}` MUST be called
- **AND** child collections MUST reparent to the deleted node's parent (reflecting backend ON DELETE SET NULL semantics)
- **AND** the confirm dialog MUST warn that pages in the collection are NOT deleted — only removed from this collection

### Requirement: Drag-and-Drop Pages into Collections
The dashboard SHALL support dragging a `PageCard` onto a collection in the sidebar to add it to that collection.

#### Scenario: Drop page onto collection
- **WHEN** the user drags a `PageCard` and drops it on a collection node
- **THEN** the card MUST optimistically show a "Moved to X" toast with Undo
- **AND** the app MUST call `POST /api/v1/library/collections/{id}/pages` with the page_id
- **AND** on error the toast MUST revert to an error toast and the optimistic state MUST be rolled back

#### Scenario: Drag indicator
- **WHEN** a card is being dragged
- **THEN** every collection node MUST show a hover/drop-target highlight while the card is over it
- **AND** invalid drop targets (e.g. the currently-selected collection if membership is trivially present) MUST visually indicate "already in this collection"

### Requirement: Accessible Drag Alternative
All drag-and-drop interactions SHALL have a keyboard- and screen-reader-accessible alternative.

#### Scenario: Keyboard move
- **WHEN** the user focuses a `PageCard` and presses `Shift+M`
- **THEN** a combobox MUST open listing collections; selecting one MUST perform the same move as a drop
- **AND** screen readers MUST announce the moved state as "Moved to <collection name>"
