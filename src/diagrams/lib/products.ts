// The admin's lib/products.ts, cut down to the one thing the diagram files ask of it.
// In Switchboard a diagram belongs to a WORKSPACE, not a product: wherever the copied
// admin code says `productId`, it is the workspace's id (src/main/diagrams.js keys its
// folders by it).

export type ProductId = string
