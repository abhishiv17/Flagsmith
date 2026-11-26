import { getPool } from '../lib/db.js';

/**
 * Retailer accounts (doc/18). A partner shop has an owner email; whoever signs in with that email
 * (the same passwordless code as shoppers, doc/17) runs that shop and sees only its dashboard.
 */
export interface Shop {
  id: number; slug: string; name: string; city: string; cityName: string; rating: number; deliveryNote: string;
}

type Row = { id: number; slug: string; name: string; city_code: string; city_name: string; rating: string; delivery_note: string };
const SELECT = `SELECT s.id, s.slug, s.name, s.city_code, c.name AS city_name, s.rating, s.delivery_note
                  FROM sellers s JOIN cities c ON c.code = s.city_code`;
const toShop = (r: Row): Shop => ({
  id: r.id, slug: r.slug, name: r.name, city: r.city_code, cityName: r.city_name, rating: Number(r.rating), deliveryNote: r.delivery_note,
});

export async function shopForEmail(email: string): Promise<Shop | null> {
  const { rows } = await getPool().query<Row>(`${SELECT} WHERE lower(s.owner_email) = lower($1)`, [email]);
  return rows[0] ? toShop(rows[0]) : null;
}

export async function shopById(id: number): Promise<Shop | null> {
  const { rows } = await getPool().query<Row>(`${SELECT} WHERE s.id = $1`, [id]);
  return rows[0] ? toShop(rows[0]) : null;
}

/** Shops that have an owner account (the store admin can open any of them). */
export async function listShops(): Promise<Shop[]> {
  const { rows } = await getPool().query<Row>(`${SELECT} WHERE s.owner_email IS NOT NULL ORDER BY s.city_code, s.name`);
  return rows.map(toShop);
}
