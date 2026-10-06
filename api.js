import { getDatabase } from "@netlify/database";

export const config = { path: "/api/db" };

const json = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });

const snapshot = async (db) => ({
  products: await db.sql`SELECT id, name, price::float8 AS price, stock FROM products ORDER BY id DESC`,
  sales: await db.sql`SELECT id, created_at AS time, customer, product, qty, total::float8 AS total FROM sales ORDER BY id DESC LIMIT 500`,
  history: await db.sql`SELECT id, created_at AS time, action, detail FROM history ORDER BY id DESC LIMIT 300`,
});

export default async (req) => {
  try {
    const db = getDatabase();
    if (req.method === "GET") return json(await snapshot(db));
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const b = await req.json();
    const bad = (m) => json({ error: m }, 400);
    const log = (action, detail) => db.sql`INSERT INTO history (action, detail) VALUES (${action}, ${detail})`;
    const name = (b.name || "").trim();
    const price = Number(b.price), stock = Number(b.stock);

    if (b.action === "addProduct" || b.action === "updateProduct") {
      if (!name) return bad("Product name is required");
      if (!(price >= 0)) return bad("Price must be 0 or more");
      if (!(Number.isInteger(stock) && stock >= 0)) return bad("Stock must be a whole number, 0 or more");

      if (b.action === "addProduct") {
        await db.sql`INSERT INTO products (name, price, stock) VALUES (${name}, ${price}, ${stock})`;
        await log("Product added", `${name} (price ${price}, stock ${stock})`);
      } else {
        const [old] = await db.sql`SELECT name FROM products WHERE id = ${b.id}`;
        if (!old) return bad("Product not found");
        await db.sql`UPDATE products SET name = ${name}, price = ${price}, stock = ${stock} WHERE id = ${b.id}`;
        await log("Product edited", `${old.name} -> ${name} (price ${price}, stock ${stock})`);
      }
    } else if (b.action === "deleteProduct") {
      const [old] = await db.sql`SELECT name FROM products WHERE id = ${b.id}`;
      if (!old) return bad("Product not found");
      await db.sql`DELETE FROM products WHERE id = ${b.id}`;
      await log("Product deleted", old.name);
    } else if (b.action === "sell") {
      const qty = Number(b.qty);
      if (!(Number.isInteger(qty) && qty > 0)) return bad("Quantity must be a whole number above 0");
      const customer = (b.customer || "").trim() || "Walk-in customer";
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query("SELECT * FROM products WHERE id = $1 FOR UPDATE", [b.productId]);
        const p = rows[0];
        if (!p) { await client.query("ROLLBACK"); return bad("Choose a product"); }
        if (qty > p.stock) { await client.query("ROLLBACK"); return bad(`Only ${p.stock} of ${p.name} in stock`); }
        await client.query("UPDATE products SET stock = stock - $1 WHERE id = $2", [qty, p.id]);
        await client.query("INSERT INTO sales (customer, product, qty, total) VALUES ($1, $2, $3, $4)", [customer, p.name, qty, qty * Number(p.price)]);
        await client.query("INSERT INTO history (action, detail) VALUES ($1, $2)", ["Sale recorded", `${qty} x ${p.name} to ${customer}`]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    } else {
      return bad("Unknown action");
    }

    return json(await snapshot(db));
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
