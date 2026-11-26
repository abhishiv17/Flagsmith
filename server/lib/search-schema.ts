/** OpenSearch index settings + mapping (doc/04 §3). v3 (doc/19): features, uses, need synonyms, stop words, light stemming. */
export const productsIndexBody = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    analysis: {
      filter: {
        // Natural sentences ("something to keep my tea hot"): drop filler words, keep the meaning.
        shop_stop: { type: 'stop', stopwords: ['_english_', 'something', 'need', 'want', 'looking', 'good', 'best', 'my', 'me', 'i', 'buy', 'get', 'please', 'which', 'thing', 'stuff'] },
        shop_stem: { type: 'stemmer', language: 'light_english' },
        shop_synonyms: {
          type: 'synonym_graph',
          synonyms: [
            // doc/19: kept apart so "tws" doesn't return wired earphones and "headphones" isn't "earbuds"
            'tws, true wireless, earbuds, ear buds',
            'earphones => earphones, in-ear, earbuds',
            'headphones => headphones, over-ear, headset, earbuds, earphones',
            'over-ear, over ear, headset',
            'speaker, soundbox, speakers',
            'bottle, flask, sipper',
            'charger, adapter',
            'power bank, powerbank, portable charger, battery pack',
            'backpack, bag, rucksack, school bag',
            'smartwatch, smart watch, watch',
            'cable, cord, wire',
            // doc/19: the words people use for needs, mapped to the words in product details
            'anc, noise cancelling, noise canceling, noise cancellation',
            'waterproof, water resistant, splash proof, splash-proof, ipx7, ipx8, rainproof',
            'hot, warm, insulated, thermos',
            'tea, chai',
            'gym, workout, fitness, exercise',
            'run, running, jog, jogging',
            'cycle, cycling, bike, scooter',
            'kid, kids, child, children',
            'parents, senior, elderly, grandparents',
            'flight, plane, airplane',
            'sleep, sleeping, bedtime',
            'laptop, notebook',
            'tiffin, lunchbox, lunch box',
            'power cut, power outage, load shedding',
            'phone, mobile, smartphone',
          ],
        },
      },
      analyzer: {
        // light_english: "keeps" matches "keep", "flights" matches "flight", without over-stemming names.
        product_text: { tokenizer: 'standard', filter: ['lowercase', 'asciifolding', 'shop_stop', 'shop_stem'] },
        product_text_syn: { tokenizer: 'standard', filter: ['lowercase', 'asciifolding', 'shop_synonyms', 'shop_stop', 'shop_stem'] },
      },
    },
  },
  mappings: {
    dynamic: 'strict',
    properties: {
      product_id: { type: 'integer' },
      sku: { type: 'keyword' },
      name: {
        type: 'text',
        analyzer: 'product_text',
        fields: { kw: { type: 'keyword' }, sayt: { type: 'search_as_you_type' } },
      },
      brand: { type: 'text', analyzer: 'product_text', fields: { kw: { type: 'keyword' } } },
      category: { type: 'keyword' },
      description: { type: 'text', analyzer: 'product_text' },
      tags: { type: 'text', analyzer: 'product_text' },
      // doc/19: feature bullets (searched) and "good for" occasions (facet + boost)
      features: { type: 'text', analyzer: 'product_text' },
      uses: { type: 'keyword' },
      // doc/19: full details (searched) and normalised attributes (filters, facets, ranking)
      about: { type: 'text', analyzer: 'product_text' },
      specs_text: { type: 'text', analyzer: 'product_text' },
      in_box: { type: 'text', analyzer: 'product_text' },
      colour: { type: 'keyword' },
      connectivity: { type: 'keyword' },
      water_rating: { type: 'keyword' },
      battery_hours: { type: 'integer' },
      weight_g: { type: 'integer' },
      price_paise: { type: 'integer' },
      image_key: { type: 'keyword', index: false },
      city: { type: 'keyword' },
      city_name: { type: 'keyword' },
      qty: { type: 'integer' },
      in_stock: { type: 'boolean' },
      stock_version: { type: 'long' },
      updated_at: { type: 'date' },
    },
  },
} as const;
