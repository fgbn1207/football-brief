/**
 * 足球热点简报 - Cloudflare Worker (all-in-one)
 * HTML 直接内嵌，无需 KV
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    const corsHdrs = { 'Access-Control-Allow-Origin': '*' };
    try {
      if (path === '/' || path === '/index.html') {
        return new Response(HTML_CONTENT, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600', ...corsHdrs },
        });
      }
      if (path.startsWith('/api/dqd/')) {
        return await handleDQD(path, corsHdrs);
      }
      if (path === '/health') {
        return new Response(JSON.stringify({ status: 'ok', timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json', ...corsHdrs },
        });
      }
      if (path === '/api/sync/pull') {
        return await handleSyncPull(request, env, corsHdrs);
      }
      if (path === '/api/sync/push' && request.method === 'POST') {
        return await handleSyncPush(request, env, corsHdrs);
      }
      if (path === '/api/sync/clear' && request.method === 'POST') {
        return await handleSyncClear(request, env, corsHdrs);
      }
      return new Response('Not Found', { status: 404, headers: corsHdrs });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHdrs },
      });
    }
  },
};

async function handleDQD(path, corsHdrs) {
  const subPath = path.replace('/api/dqd', '');
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
  const jsonResp = (data, maxAge = 300) => new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=' + maxAge },
  });

  if (subPath === '/articles') {
    // Primary: DQD JSON API. Fallback: HTML scraping if API is blocked.
    let articles = [];
    try {
      const resp = await fetch('https://api.dongqiudi.com/app/tabs/iphone/104.json', {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      });
      if (resp.ok) {
        const data = await resp.json();
        const rawList = data.contents || [];
        articles = rawList.filter(a => a.title).map(a => ({
          id: String(a.id),
          title: a.title || '',
          comments_total: a.comments_total || a.comment_count || 0,
          published_at: a.published_at || a.publish_time || a.time || '',
          sort_timestamp: a.sort_timestamp || a.timestamp || a.published_at_ts || 0,
          description: a.description || a.summary || '',
          url: 'https://m.dongqiudi.com/article/' + a.id + '.html',
        }));
      }
    } catch(e) {}

    // Fallback: scrape HTML page if JSON API failed
    if (articles.length === 0) {
      try {
        const htmlResp = await fetch('https://m.dongqiudi.com/home/104', {
          headers: { 'User-Agent': UA },
        });
        const htmlText = await htmlResp.text();
        const stateIdx = htmlText.indexOf('__INITIAL_STATE__=');
        if (stateIdx >= 0) {
          const eqIdx = htmlText.indexOf('=', stateIdx);
          const bs = htmlText.indexOf('{', eqIdx);
          if (bs >= 0) {
            let d=0, ep=-1, is=false, es=false;
            for (let i=bs; i<htmlText.length; i++) {
              const ch=htmlText[i];
              if (es) { es=false; continue; }
              if (ch==='\\') { if (is) es=true; continue; }
              if (ch==='"') { is=!is; continue; }
              if (is) continue;
              if (ch==='{') d++;
              else if (ch==='}') { d--; if (d===0) { ep=i+1; break; } }
            }
            if (ep > bs) {
              const st = JSON.parse(htmlText.substring(bs, ep));
              const newsList = (st.newsListStore && st.newsListStore.newsList) || [];
              articles = newsList.filter(a => a && a.title).map(a => ({
                id: String(a.id),
                title: a.title || '',
                comments_total: a.comments_total || a.comment_count || 0,
                published_at: a.published_at || a.publish_time || '',
                sort_timestamp: a.sort_timestamp || a.timestamp || 0,
                description: a.description || a.summary || '',
                url: 'https://m.dongqiudi.com/article/' + a.id + '.html',
              }));
            }
          }
        }
      } catch(e) {}
    }

    return jsonResp({ articles });
  }

  if (subPath === '/debug') {
    // Diagnostic endpoint
    const resp = await fetch('https://api.dongqiudi.com/app/tabs/iphone/104.json', {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    });
    const data = await resp.json();
    return jsonResp({
      status: resp.status,
      hasContents: !!(data.contents),
      contentsLen: (data.contents || []).length,
      label: data.label,
      id: data.id,
      firstArticle: (data.contents || [])[0] ? {
        id: (data.contents[0] || {}).id,
        title: ((data.contents[0] || {}).title || '').substring(0, 40),
      } : null,
    }, 0);
  }

  if (subPath.startsWith('/hot_comment/')) {
    const articleId = subPath.split('/')[2];
    if (!articleId || !/^\d+$/.test(articleId)) return jsonResp({ error: 'invalid id' }, 0);
    // Fetch from both endpoints: /hot_comment (top 3 editorial picks) + /comment (community top by likes)
    const [hotResp, commentResp] = await Promise.all([
      fetch('https://m.dongqiudi.com/api/v2/article/' + articleId + '/hot_comment', {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      }).catch(() => null),
      fetch('https://m.dongqiudi.com/api/v2/article/' + articleId + '/comment', {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      }).catch(() => null),
    ]);
    const uMap = {};
    const seenIds = new Set();
    const hotComments = [];

    // 1) Hot comments from editorial /hot_comment endpoint (highest quality)
    if (hotResp && hotResp.ok) {
      try {
        const hd = await hotResp.json();
        (hd.data?.user_list || []).forEach(u => { uMap[String(u.id)] = u.username || '匿名'; });
        for (const c of (hd.data?.comment_list || [])) {
          if (seenIds.has(String(c.id))) continue;
          seenIds.add(String(c.id));
          hotComments.push({
            user: uMap[String(c.user_id)] || '匿名',
            content: (c.content || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim(),
            likes: String(c.up || '0'),
          });
          if (hotComments.length >= 10) break;
        }
      } catch(e) {}
    }

    // 2) Supplement from /comment endpoint sorted by likes (community favorites)
    if (hotComments.length < 10 && commentResp && commentResp.ok) {
      try {
        const cd = await commentResp.json();
        (cd.data?.user_list || []).forEach(u => { uMap[String(u.id)] = u.username || '匿名'; });
        const sorted = (cd.data?.comment_list || [])
          .filter(c => !seenIds.has(String(c.id)))
          .sort((a, b) => (b.up || 0) - (a.up || 0));
        for (const c of sorted) {
          if (hotComments.length >= 10) break;
          seenIds.add(String(c.id));
          hotComments.push({
            user: uMap[String(c.user_id)] || '匿名',
            content: (c.content || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim(),
            likes: String(c.up || '0'),
          });
        }
      } catch(e) {}
    }

    return jsonResp({ hotComments }, 600);
  }

  if (subPath.startsWith('/article/')) {
    const articleId = subPath.split('/')[2];
    if (!articleId || !/^\d+$/.test(articleId)) return jsonResp({ error: 'invalid id' }, 0);
    const resp = await fetch('https://m.dongqiudi.com/article/' + articleId + '.html', {
      headers: { 'User-Agent': UA },
    });
    const htmlText = await resp.text();
    let summary = '';
    const idx = htmlText.indexOf('__INITIAL_STATE__=') >= 0 ? htmlText.indexOf('__INITIAL_STATE__=') : htmlText.indexOf('__INITIAL_STATE__ =');
    if (idx >= 0) {
      const eqIdx = htmlText.indexOf('=', idx);
      const bs = htmlText.indexOf('{', eqIdx);
      if (bs >= 0) {
        let d=0, ep=-1, is=false, es=false;
        for (let i=bs; i<htmlText.length; i++) {
          const ch=htmlText[i];
          if (es) { es=false; continue; }
          if (ch==='\\') { if (is) es=true; continue; }
          if (ch==='"') { is=!is; continue; }
          if (is) continue;
          if (ch==='{') d++;
          else if (ch==='}') { d--; if (d===0) { ep=i+1; break; } }
        }
        if (ep > bs) {
          try {
            const st = JSON.parse(htmlText.substring(bs, ep));
            const ac = (st.articleContent || {})[articleId] || {};
            const rawBody = ac.body || '';
            if (rawBody) {
              summary = rawBody.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
            } else {
              summary = st.articleData?.article?.description || st.articleData?.article?.b_description || '';
            }
          } catch(e) {}
        }
      }
    }
    if (!summary) {
      const m = htmlText.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
      if (m) summary = m[1];
    }
    summary = summary.replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#x27;/g,"'").replace(/......,/g,'……');
    if (summary.length > 200) summary = summary.substring(0, 200) + '...';
    return jsonResp({ summary }, 3600);
  }

  return new Response(JSON.stringify({ error: 'unknown' }), {
    status: 404, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

async function handleSyncPull(request, env, corsHdrs) {
  var jsonHdrs = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
  if (!env.READ_KV) return new Response(JSON.stringify({ error: 'KV not configured', urls: [] }), { status: 503, headers: jsonHdrs });
  var rUrl = new URL(request.url);
  var code = rUrl.searchParams.get('code');
  if (!code) return new Response(JSON.stringify({ error: 'missing code', urls: [] }), { status: 400, headers: jsonHdrs });
  try {
    var raw = await env.READ_KV.get('sync:' + code, 'json');
    var urls = (raw && Array.isArray(raw.urls)) ? raw.urls : [];
    return new Response(JSON.stringify({ ok: true, urls: urls, updated: (raw && raw.updated) || 0 }), { headers: jsonHdrs });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message, urls: [] }), { status: 500, headers: jsonHdrs });
  }
}

async function handleSyncPush(request, env, corsHdrs) {
  var jsonHdrs = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
  if (!env.READ_KV) return new Response(JSON.stringify({ error: 'KV not configured' }), { status: 503, headers: jsonHdrs });
  try {
    var body = await request.json();
    var code = body.code;
    var newUrls = body.urls || [];
    if (!code) return new Response(JSON.stringify({ error: 'missing code' }), { status: 400, headers: jsonHdrs });
    var existing;
    try { existing = await env.READ_KV.get('sync:' + code, 'json'); } catch(e) { existing = null; }
    if (!existing || !Array.isArray(existing.urls)) existing = { urls: [] };
    var urlSet = new Set(existing.urls);
    newUrls.forEach(function(u) { urlSet.add(u); });
    var merged = { urls: Array.from(urlSet), updated: Date.now() };
    await env.READ_KV.put('sync:' + code, JSON.stringify(merged), { expirationTtl: 7776000 });
    return new Response(JSON.stringify({ ok: true, total: merged.urls.length }), { headers: jsonHdrs });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: jsonHdrs });
  }
}

async function handleSyncClear(request, env, corsHdrs) {
  var jsonHdrs = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
  if (!env.READ_KV) return new Response(JSON.stringify({ error: 'KV not configured' }), { status: 503, headers: jsonHdrs });
  try {
    var body = await request.json();
    var code = body.code;
    if (!code) return new Response(JSON.stringify({ error: 'missing code' }), { status: 400, headers: jsonHdrs });
    await env.READ_KV.put('sync:' + code, JSON.stringify({ urls: [], updated: Date.now() }), { expirationTtl: 7776000 });
    return new Response(JSON.stringify({ ok: true }), { headers: jsonHdrs });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: jsonHdrs });
  }
}

var HTML_CONTENT = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>热门足球资讯直通车</title>\n<style>\n  * { margin: 0; padding: 0; box-sizing: border-box; }\n  body {\n    overflow-x: hidden;\n    font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', \'PingFang SC\', \'Hiragino Sans GB\', \'Microsoft YaHei\', sans-serif;\n    background: linear-gradient(135deg, #0f1923 0%, #1a2a3a 50%, #0d1b2a 100%);\n    color: #e0e0e0; min-height: 100vh; padding: 20px; padding-bottom: 90px;\n  }\n  .container { max-width: 800px; margin: 0 auto; }\n  .header { text-align: center; padding: 30px 20px 20px; margin-bottom: 24px; }\n  .header h1 { font-size: 28px; color: #fff; margin-bottom: 8px; letter-spacing: 2px; }\n  .header .subtitle { font-size: 14px; color: #7fb3d3; margin-bottom: 6px; }\n  .header .last-refresh { font-size: 11px; color: #546e7a; margin-bottom: 14px; }\n  .btn-group { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-bottom: 4px; }\n  .refresh-btn {\n    display: inline-flex; align-items: center; gap: 8px;\n    padding: 10px 22px; background: linear-gradient(135deg, #1e88e5, #1565c0);\n    color: #fff; border: none; border-radius: 24px; font-size: 14px;\n    cursor: pointer; transition: all 0.3s; box-shadow: 0 4px 15px rgba(30,136,229,0.3); outline: none;\n  }\n  .refresh-btn:hover { background: linear-gradient(135deg, #2196f3, #1976d2); transform: translateY(-2px); }\n  .refresh-btn.secondary {\n    background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15);\n    box-shadow: none; font-size: 13px; padding: 8px 18px;\n  }\n  .refresh-btn.secondary:hover { background: rgba(255,255,255,0.12); }\n  .stats-bar { display: flex; justify-content: center; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }\n  .stat-item {\n    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);\n    border-radius: 12px; padding: 12px 18px; text-align: center; min-width: 90px;\n  }\n  .stat-num { font-size: 22px; font-weight: 700; color: #4fc3f7; }\n  .stat-label { font-size: 12px; color: #90a4ae; margin-top: 4px; }\n  .stat-item.read-stat .stat-num { color: #66bb6a; }\n\n  .card {\n    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);\n    border-radius: 14px; padding: 20px 20px 16px; margin-bottom: 16px;\n    position: relative; overflow: hidden; animation: fadeIn 0.4s ease both;\n    transition: background 0.3s, border-color 0.3s, transform 0.3s, box-shadow 0.3s, opacity 0.3s;\n  }\n  .card::before {\n    content: ""; position: absolute; top: 0; left: 0; width: 4px; height: 100%;\n    background: linear-gradient(180deg, #4fc3f7, #1e88e5); border-radius: 4px 0 0 4px;\n  }\n  .card.dqd-card::before {\n    background: linear-gradient(180deg, #4caf50, #16b13a);\n  }\n  .card:hover {\n    background: rgba(255,255,255,0.07); border-color: rgba(79,195,247,0.2);\n    transform: translateY(-2px); box-shadow: 0 8px 30px rgba(0,0,0,0.3);\n  }\n'
  + '  .card.dqd-card:hover { border-color: rgba(76,175,80,0.2); }\n  @keyframes fadeIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }\n\n  .card-top-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }\n  .card-badge {\n    display: inline-flex; align-items: center; justify-content: center;\n    width: 30px; height: 30px; background: linear-gradient(135deg, #4fc3f7, #1e88e5);\n    border-radius: 50%; font-weight: 700; font-size: 14px; color: #fff; flex-shrink: 0;\n  }\n  .card.dqd-card .card-badge { background: linear-gradient(135deg, #66bb6a, #16b13a); }\n  .card-top-right { display: flex; align-items: center; gap: 8px; }\n  .card-meta-top { display: flex; gap: 8px; align-items: center; }\n  .meta-tag {\n    display: inline-flex; align-items: center; gap: 3px;\n    padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500;\n  }\n  .meta-tag.hot { background: rgba(244,67,54,0.15); color: #ef5350; border: 1px solid rgba(244,67,54,0.2); }\n  .meta-tag.time { background: rgba(79,195,247,0.1); color: #4fc3f7; border: 1px solid rgba(79,195,247,0.15); }\n  .card.dqd-card .meta-tag.time { background: rgba(76,175,80,0.1); color: #66bb6a; border: 1px solid rgba(76,175,80,0.15); }\n  .source-tag {\n    display: inline-flex; align-items: center; gap: 3px;\n    padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600;\n  }\n  .source-tag.zhibo8 { background: rgba(30,136,229,0.15); color: #42a5f5; border: 1px solid rgba(30,136,229,0.2); }\n  .source-tag.dqd { background: rgba(22,177,58,0.15); color: #66bb6a; border: 1px solid rgba(22,177,58,0.2); }\n\n  .read-btn {\n    display: flex; align-items: center; justify-content: center; gap: 6px;\n    width: 100%; padding: 10px 0; border-radius: 8px; margin-top: 12px;\n    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1);\n    color: #90a4ae; font-size: 13px; cursor: pointer; transition: all 0.25s;\n  }\n  .read-btn:hover { background: rgba(76,175,80,0.12); border-color: rgba(76,175,80,0.3); color: #66bb6a; }\n  .read-btn.is-read { background: rgba(76,175,80,0.15); border-color: rgba(76,175,80,0.35); color: #66bb6a; pointer-events: none; }\n\n  .card-headline { font-size: 17px; font-weight: 600; color: #fff; line-height: 1.5; margin-bottom: 12px; }\n  .card-headline a { color: #fff; text-decoration: none; }\n  .card-headline a:hover { color: #4fc3f7; }\n  .card.dqd-card .card-headline a:hover { color: #66bb6a; }\n\n  .ai-summary {\n    background: rgba(79,195,247,0.06); border-left: 3px solid #4fc3f7;\n    border-radius: 0 8px 8px 0; padding: 10px 14px; margin-bottom: 12px;\n  }\n  .card.dqd-card .ai-summary {\n    background: rgba(76,175,80,0.06); border-left-color: #66bb6a;\n  }\n  .ai-summary-label { font-size: 12px; color: #4fc3f7; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 4px; }\n  .card.dqd-card .ai-summary-label { color: #66bb6a; }\n'
  + '  .ai-summary-text { font-size: 15px; line-height: 1.5; color: #b0bec5; }\n\n  .comments-divider { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; color: #546e7a; font-size: 12px; }\n  .comments-divider::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, rgba(79,195,247,0.2), transparent); }\n  .card.dqd-card .comments-divider::after { background: linear-gradient(90deg, rgba(76,175,80,0.2), transparent); }\n  .comment-item { padding: 8px 0; font-size: 14px; line-height: 1.6; color: #b0bec5; border-bottom: 1px solid rgba(255,255,255,0.03); }\n  .comment-item:last-child { border-bottom: none; }\n  .comment-likes-badge {\n    display: inline-block; background: rgba(244,67,54,0.12); color: #ef5350;\n    font-size: 11px; font-weight: 500; padding: 1px 6px; border-radius: 8px; mar