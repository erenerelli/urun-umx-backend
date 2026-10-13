import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const app = express();
const PORT = Number(process.env.PORT || 10000);
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '24kb' }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Math.max(1, Number(process.env.RATE_LIMIT_MAX || 30)),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Çok fazla istek gönderildi. Biraz sonra tekrar dene.' }
}));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'UrunumX AI', configured: Boolean(TAVILY_API_KEY && GEMINI_API_KEY) });
});

function safeText(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizeSource(item) {
  let url = '';
  try {
    const parsed = new URL(item.url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') url = parsed.toString();
  } catch { /* invalid link is skipped */ }
  if (!url) return null;
  return {
    title: safeText(item.title || item.url, 180),
    url,
    snippet: safeText(item.content || item.raw_content || '', 900)
  };
}

async function tavilySearch(query) {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      search_depth: 'basic',
      topic: 'general',
      max_results: 6,
      include_answer: false,
      include_raw_content: false
    }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`İnternet araması başarısız (${response.status}). ${body.slice(0, 160)}`);
  }
  const data = await response.json();
  return (Array.isArray(data.results) ? data.results : []).map(normalizeSource).filter(Boolean);
}

async function geminiSummary(mode, productA, productB, sources) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY sunucuya tanımlanmamış.');
  const evidence = sources.map((s, i) => `${i + 1}. Başlık: ${s.title}\nURL: ${s.url}\nİçerik özeti: ${s.snippet}`).join('\n\n');
  const task = mode === 'compare'
    ? `Şu iki ürünü karşılaştır: A=${productA}; B=${productB}. Teknik farkları, kullanım senaryolarını ve kanıt yeterliliğini anlat. Birini kesin kazanan ilan etmek zorunda değilsin.`
    : mode === 'prices'
      ? `Şu ürün için fiyat araştırması yap: ${productA}. Yalnızca verilen kaynak metinlerinde görünen fiyatlar hakkında konuş. Fiyat görünmüyorsa bunu açıkça belirt. Aynı model, kapasite, renk veya satıcı koşulları farklı olabilir.`
      : `Şu ürün/istek için araştırma yap: ${productA}. Teknik özellikleri, artı-eksi yönlerini ve satın alma öncesi kontrol edilmesi gerekenleri özetle.`;

  const prompt = `Sen ÜrünümX'in ürün araştırma asistanısın. Türkçe yanıt ver.\n${task}\n\nGÜVENLİ KAYNAK KURALI: Sadece aşağıda verilen arama sonuçlarından desteklenen olguları yaz. Teknik özellik, fiyat, stok, garanti veya satıcı hakkında kaynakta görünmeyen bir bilgiyi uydurma. Kaynaklar çelişiyorsa belirt. Güncel fiyat/stoğu kesin olarak doğruladığını iddia etme. Üretici kaynağı varsa onu tercih et.\n\nARAMA SONUÇLARI:\n${evidence || 'Sonuç bulunamadı.'}\n\nSadece şu JSON yapısıyla yanıt ver: {"summary":"2-5 cümlelik bulgu özeti","recommendation":"İhtiyaca göre dengeli değerlendirme; yeterli kanıt yoksa bunu söyle"}. Markdown çiti kullanma.`;

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
    }),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`AI yanıtı alınamadı (${response.status}). ${body.slice(0, 180)}`);
  }
  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('AI boş yanıt döndürdü. Model adını ve ücretsiz kota durumunu kontrol et.');
  try {
    const parsed = JSON.parse(text);
    return {
      summary: safeText(parsed.summary, 2500) || 'Kaynaklar bulundu ancak özet oluşturulamadı.',
      recommendation: safeText(parsed.recommendation, 2500)
    };
  } catch {
    return { summary: text.slice(0, 3000), recommendation: 'Yanıt JSON biçiminde gelmedi; kaynak bağlantılarını ayrıca kontrol et.' };
  }
}

function extractOffers(sources) {
  const pricePattern = /(?:₺\s?\d[\d. ]*(?:,\d{2})?|\b\d[\d. ]*(?:,\d{2})?\s?(?:₺|TL|TRY)\b)/i;
  return sources.map((source) => {
    const combined = `${source.title} ${source.snippet}`;
    let price = 'Kaynak metninde fiyat görünmüyor';
    const match = combined.match(pricePattern);
    if (match) price = match[0].trim();
    let merchant = 'Web kaynağı';
    try { merchant = new URL(source.url).hostname.replace(/^www\./, ''); } catch { /* default */ }
    return { title: source.title, price, merchant, url: source.url, snippet: source.snippet };
  });
}

app.post('/api/research', async (req, res) => {
  const mode = safeText(req.body?.mode, 20);
  const query = safeText(req.body?.query, 200);
  const productA = safeText(req.body?.productA || query, 200);
  const productB = safeText(req.body?.productB, 200);

  if (!['research', 'prices', 'compare'].includes(mode)) {
    return res.status(400).json({ error: 'mode research, prices veya compare olmalı.' });
  }
  if (!TAVILY_API_KEY || !GEMINI_API_KEY) {
    return res.status(503).json({ error: 'AI servisi yapılandırılmamış. Sunucu ortam değişkenlerinde TAVILY_API_KEY ve GEMINI_API_KEY ayarla.' });
  }
  if (mode === 'compare' && (!productA || !productB || productA.toLowerCase() === productB.toLowerCase())) {
    return res.status(400).json({ error: 'Karşılaştırmak için birbirinden farklı iki ürün gir.' });
  }
  if (mode !== 'compare' && !query) return res.status(400).json({ error: 'Arama metni boş olamaz.' });

  try {
    let sources;
    if (mode === 'compare') {
      const [aSources, bSources] = await Promise.all([
        tavilySearch(`${productA} teknik özellikler resmi site fiyat Türkiye`),
        tavilySearch(`${productB} teknik özellikler resmi site fiyat Türkiye`)
      ]);
      // Bir modelin sonuçlarının diğerini tamamen kaplamaması için ürün adıyla eşleştirerek harmanla.
      sources = [...aSources, ...bSources].filter((source, index, list) =>
        list.findIndex((s) => s.url === source.url) === index
      ).slice(0, 10);
    } else {
      const searchQuery = mode === 'prices'
        ? `${query} güncel fiyat Türkiye mağaza TL`
        : `${query} teknik özellikler resmi üretici site Türkiye fiyat`;
      sources = (await tavilySearch(searchQuery)).slice(0, 8);
    }

    if (!sources.length) {
      return res.json({
        summary: 'Arama servisi bu sorgu için kaynak bulamadı. Model numarasını ekleyip tekrar dene.',
        recommendation: 'Ürün adı, varyantı ve model numarası doğru yazılmalı.',
        sources: [],
        offers: []
      });
    }
    const ai = await geminiSummary(mode, productA || query, productB, sources);
    return res.json({
      summary: ai.summary,
      recommendation: ai.recommendation,
      sources,
      offers: mode === 'prices' || mode === 'compare' ? extractOffers(sources) : []
    });
  } catch (error) {
    console.error('Research request failed:', error?.message || error);
    return res.status(502).json({ error: error?.message || 'Araştırma servisi geçici olarak yanıt vermedi.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ÜrünümX AI backend listening on ${PORT}`);
});
