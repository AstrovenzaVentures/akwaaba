// POST /api/quote
// Returns the route from the airport, the zone and the fare for a drop-off point. Saves nothing.
import { parseQuoteRequest } from '../lib/validate.js';
import { priceTrip, publicQuote } from '../lib/quote.js';
import { json, handle, readJson } from '../lib/http.js';

export async function POST(request) {
  return handle(async () => {
    const { data: trip, error } = parseQuoteRequest(await readJson(request));
    if (error) return json(400, { error });
    const priced = await priceTrip(trip);
    if (priced.error) return json(422, { error: priced.error });
    return json(200, publicQuote(priced));
  });
}
