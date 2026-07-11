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
    const