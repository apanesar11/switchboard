// The admin's lib/products.ts, cut down to the one name the mirrored diagram files
// may still mention. Switchboard: nothing here is keyed by product any more. A
// whiteboard belongs to a folder the user made and is addressed by its own id; the
// workspace ✦ Answer reads is a field on the board (lib/bridge.ts WhiteboardSummary).
// Kept so admin code copied across with a `ProductId` in it still compiles.

export type ProductId = string
