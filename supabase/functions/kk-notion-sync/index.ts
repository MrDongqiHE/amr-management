// kk-notion-sync v7
// v5 变更：
// 1. sync: 同步问题正文 content（fetchBlockText 把 Notion blocks 转纯文本）
// 2. sync: 修复所属项目 relation 解析（titleOfPage 单独提取）
// 3. 新增 action=update-content：网页编辑正文后写回 Notion（删旧块+写新段落）
// 4. update-status 支持 Doing/Waiting（去掉后缀）
// v6: 重新部署时 verify_jwt=false（前端无 Authorization 头，true 会 401）
// v7: 新增文件附件接口
// v8: 文件方案改为"OneDrive 路径索引"：add-file 手动登记文件名+OneDrive路径（仅文本），
//     点击复制路径后从公司 OneDrive 打开。不再上传文件到 Supabase Storage（无容量/50MB限制）
// v9: 新增 4 个 Notion 库镜像同步：sync-experience / sync-official / sync-unofficial / sync-skills
//     + update-experience（网页编辑经验条目写回 Notion，B 模式）
// v10: 修复经验库"问题名称"为空：该属性是 title 类型，之前误用 plain()（rich_text）解析全为 null，改用 plainTitle()
// v11: 修复官方/非官方资料库"资料名称"同样为空的问题（同 v10 根因：title 类型属性必须用 plainTitle）
// v12: 新增 update-due action：拖拽改"预计完成"日期（null=清空），双写 Supabase + Notion
// v13: 新增 attendance 镜像（员工出勤记录库）：sync-attendance 同步到 notion_attendance 表
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const NOTION_DB_ID = "4226f757e9c98114aee1ee4978832d69";
// v13: CORS —— 公网部署（Vercel 等）后浏览器跨域直连本函数，需返回 CORS 头并处理预检
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};
const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", ...CORS } });
const plain = (prop: any) => prop?.rich_text?.map((t: any) => t.plain_text).join("") || null;
const plainTitle = (prop: any) => prop?.title?.map((t: any) => t.plain_text).join("") || null;

// Notion blocks -> plain markdown-ish text
async function fetchBlockText(pageId: string, headers: Record<string, string>): Promise<string> {
  let cursor: string | undefined;
  const lines: string[] = [];
  while (true) {
    const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100` + (cursor ? `&start_cursor=${cursor}` : ""), { headers });
    if (!res.ok) return lines.join("\n");
    const data = await res.json();
    for (const b of data.results as any[]) {
      const t = b.type ?? "";
      const rich = b[t]?.rich_text;
      if (Array.isArray(rich)) {
        const txt = rich.map((x: any) => x.plain_text ?? "").join("");
        if (t.startsWith("heading_")) lines.push("# " + txt);
        else if (t === "bulleted_list_item") lines.push("- " + txt);
        else if (t === "numbered_list_item") lines.push("1. " + txt);
        else if (t === "to_do") lines.push("- [" + (b[t]?.checked ? "x" : " ") + "] " + txt);
        else if (t === "quote") lines.push("> " + txt);
        else if (txt) lines.push(txt);
      }
    }
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return lines.join("\n");
}

async function titleOfPage(pid: string, headers: Record<string, string>): Promise<string | null> {
  const pr = await fetch(`https://api.notion.com/v1/pages/${pid}`, { headers });
  if (!pr.ok) return null;
  const pd = await pr.json();
  const tp = Object.values(pd.properties ?? {}).find((x: any) => x?.type === "title");
  const t = (tp?.title ?? []).map((x: any) => x.plain_text).join("");
  return t || null;
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method === "GET") return J({ ok: true });

    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const NOTION_TOKEN = Deno.env.get("NOTION_TOKEN") ?? "";
    const url = new URL(req.url);
    const action = url.searchParams.get("action") ?? "sync";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, SUPABASE_SERVICE_ROLE_KEY);
    const headers = {
      "Authorization": `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    };

    if (action === "sync") {
      if (!NOTION_TOKEN) return J({ error: "NOTION_TOKEN secret is not set" }, 500);
      let cursor: string | undefined;
      const rows: any[] = [];
      while (true) {
        const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
          method: "POST",
          headers,
          body: JSON.stringify({ start_cursor: cursor, page_size: 100 }),
        });
        if (!res.ok) {
          return J({ error: `notion_query ${res.status}: ${await res.text()}` }, 502);
        }
        const data = await res.json();
        for (const page of data.results as any[]) {
          const p = page.properties ?? {};
          const titleProp = p["编号"] ?? Object.values(p).find((x: any) => x?.type === "title");
          const code = (titleProp?.title ?? []).map((t: any) => t.plain_text).join("");
          // 所属项目: relation -> resolve page titles (store as text)
          const projectIds = (p["所属项目"]?.relation ?? []).map((r: any) => r.id);
          let project: string | null = null;
          if (projectIds.length > 0) {
            const names: string[] = [];
            for (const pid of projectIds.slice(0, 3)) {
              const t = await titleOfPage(pid, headers);
              if (t) names.push(t);
            }
            project = names.join("、") || null;
          }
          rows.push({
            notion_page_id: page.id,
            code,
            status: p["状态"]?.status?.name ?? null,
            priority: p["优先级"]?.select?.name ?? null,
            customer: p["客户/项目"]?.rich_text?.map((t: any) => t.plain_text).join("") || null,
            owner: p["负责人"]?.select?.name ?? null,
            types: (p["问题类型"]?.multi_select ?? []).map((x: any) => x.name),
            created_date: p["创建日期"]?.date?.start?.slice(0, 10) ?? null,
            resolved_date: p["实际解决日期"]?.date?.start?.slice(0, 10) ?? null,
            tech_difficulty: p["技术难度"]?.select?.name ?? null,
            due_date: p["预计完成"]?.date?.start?.slice(0, 10) ?? null,
            project,
            last_edited: page.last_edited_time ?? null,
            page_url: page.url,
            content: await fetchBlockText(page.id, headers),
          });
        }
        if (!data.has_more) break;
        cursor = data.next_cursor;
      }
      const { error } = await sb.from("notion_issues").upsert(rows, { onConflict: "notion_page_id" });
      if (error) return J({ error: `upsert: ${error.message}` }, 500);
      return J({ ok: true, synced: rows.length });
    }

    if (action === "update-status") {
      const body = await req.json().catch(() => ({}));
      const { notion_page_id, status } = body;
      if (!notion_page_id || !status) return J({ error: "notion_page_id and status required" }, 400);

      const pageRes = await fetch(`https://api.notion.com/v1/pages/${notion_page_id}`, { headers });
      if (!pageRes.ok) return J({ error: `fetch_page ${pageRes.status}: ${await pageRes.text()}` }, 502);
      const page = await pageRes.json();
      const titlePropId = Object.keys(page.properties ?? {}).find((k) => page.properties[k]?.type === "title");
      if (!titlePropId) return J({ error: "no title property found" }, 500);
      const currentTitle = (page.properties[titlePropId].title ?? []).map((t: any) => t.plain_text).join("");
      const suffix = status === "Done" ? "_WellDone" : status === "Closed" ? "_Closed" : "_未解决";
      const baseTitle = currentTitle.replace(/_(未解决|WellDone|Closed|等待rtas日志)$/, "");
      const newTitle = status === "Doing" || status === "Waiting" ? currentTitle.replace(/_(未解决|WellDone|Closed)$/, "") : baseTitle + suffix;

      const props: any = {
        状态: { status: { name: status } },
        [titlePropId]: { title: [{ text: { content: newTitle } }] },
      };
      if (status === "Done" || status === "Closed") {
        props["实际解决日期"] = { date: { start: new Date().toISOString().slice(0, 10) } };
      }

      const upd = await fetch(`https://api.notion.com/v1/pages/${notion_page_id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: props }),
      });
      if (!upd.ok) return J({ error: `update_page ${upd.status}: ${await upd.text()}` }, 502);

      await sb.from("notion_issues").update({ status, last_synced: new Date().toISOString() }).eq("notion_page_id", notion_page_id);
      return J({ ok: true, title: newTitle });
    }

    if (action === "update-content") {
      const body = await req.json().catch(() => ({}));
      const { notion_page_id, content } = body;
      if (!notion_page_id || typeof content !== "string") return J({ error: "notion_page_id and content required" }, 400);

      // replace page body: delete existing children blocks, then write new paragraph blocks
      const list = await fetch(`https://api.notion.com/v1/blocks/${notion_page_id}/children?page_size=100`, { headers });
      if (!list.ok) return J({ error: `list_blocks ${list.status}: ${await list.text()}` }, 502);
      const ld = await list.json();
      for (const b of ld.results as any[]) {
        await fetch(`https://api.notion.com/v1/blocks/${b.id}`, { method: "DELETE", headers });
      }
      // split content into lines, max 2000 chars per block, batch of 100 children
      const lines = content.split(/\n/);
      const children: any[] = [];
      for (const line of lines) {
        const parts: string[] = [];
        for (let i = 0; i < line.length; i += 1900) parts.push(line.slice(i, i + 1900));
        for (const seg of (parts.length ? parts : [""])) {
          children.push({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: seg } }] } });
        }
      }
      for (let i = 0; i < children.length; i += 100) {
        const patch = await fetch(`https://api.notion.com/v1/blocks/${notion_page_id}/children`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ children: children.slice(i, i + 100) }),
        });
        if (!patch.ok) return J({ error: `append_blocks ${patch.status}: ${await patch.text()}` }, 502);
      }
      await sb.from("notion_issues").update({ content, last_synced: new Date().toISOString() }).eq("notion_page_id", notion_page_id);
      return J({ ok: true });
    }

    // ---- 文件索引（手动登记 OneDrive 路径，仅存标题+路径文本）----
    if (action === "list-files") {
      const pid = url.searchParams.get("page_id") ?? "";
      if (!pid) return J({ error: "page_id required" }, 400);
      const { data, error } = await sb.from("issue_files").select("*").eq("notion_page_id", pid).order("created_at", { ascending: false });
      if (error) return J({ error: `list: ${error.message}` }, 500);
      const files = (data ?? []).map((f: any) => ({ id: f.id, name: f.file_name, path: f.file_path, createdAt: f.created_at }));
      return J({ files });
    }

    if (action === "add-file") {
      const body = await req.json().catch(() => ({}));
      const { notion_page_id, name, path } = body;
      if (!notion_page_id || !name || !path) return J({ error: "notion_page_id, name, path required" }, 400);
      const { error: insErr } = await sb.from("issue_files").insert({
        notion_page_id, file_path: String(path), file_name: String(name),
      });
      if (insErr) return J({ error: `insert: ${insErr.message}` }, 500);
      // 写回 Notion：在问题单末尾追加一行文件索引
      const append = await fetch(`https://api.notion.com/v1/blocks/${notion_page_id}/children`, {
        method: "PATCH", headers,
        body: JSON.stringify({ children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [
          { type: "text", text: { content: `📎 附件: ${name}\n路径: ${path}` } },
        ] } }] }),
      });
      if (!append.ok) return J({ error: `notion_append: ${append.status}: ${await append.text()}` }, 502);
      return J({ ok: true });
    }

    if (action === "delete-file") {
      const body = await req.json().catch(() => ({}));
      const { id } = body;
      if (!id) return J({ error: "id required" }, 400);
      const { error: delErr } = await sb.from("issue_files").delete().eq("id", id);
      if (delErr) return J({ error: `delete: ${delErr.message}` }, 500);
      return J({ ok: true });
    }

    // ---- v9: 4 个新库镜像同步（进网页时先调对应 sync 再读表）----
    const MIRRORS: Record<string, { table: string; dbId: string; map: (p: any) => any }> = {
      experience: {
        table: "notion_experience", dbId: "4216f757-e9c9-8133-9b9a-fc83ee4d0fe4",
        map: (p) => ({
          title: plainTitle(p["问题名称"]), type: p["问题类型"]?.select?.name ?? null,
          detail: plain(p["细节"]), solution: plain(p["解决方案"]),
          resolved_date: p["解决时间"]?.date?.start?.slice(0, 10) ?? null,
          owner: p["负责技术"]?.select?.name ?? null, note: plain(p["备注"]),
          seq: p["序号"]?.number ?? null,
        }),
      },
      official: {
        table: "notion_official_docs", dbId: "4246f757-e9c9-8140-ad8f-ce9dd220a700",
        map: (p) => ({
          title: plainTitle(p["资料名称"]), doc_no: plain(p["资料编号"]),
          topic: p["主题"]?.select?.name ?? null, module: p["模块"]?.select?.name ?? null,
          platform: p["适用平台"]?.select?.name ?? null, language: p["语言"]?.select?.name ?? null,
          version: plain(p["适用版本或车型"]),
          scenarios: (p["使用场景"]?.multi_select ?? []).map((x: any) => x.name),
          audience: (p["使用对象"]?.multi_select ?? []).map((x: any) => x.name),
          field: p["领域"]?.select?.name ?? null, keywords: plain(p["搜索关键词"]),
          source_url: p["源链接"]?.url ?? null,
          last_review: p["最后审核"]?.date?.start?.slice(0, 10) ?? null,
        }),
      },
      unofficial: {
        table: "notion_unofficial_docs", dbId: "41f6f757-e9c9-81b1-8e7b-c8d380c6b35b",
        map: (p) => ({
          title: plainTitle(p["资料名称"]), doc_no: plain(p["资料编号"]),
          topic: p["主题"]?.select?.name ?? null, module: p["模块"]?.select?.name ?? null,
          platform: p["适用平台"]?.select?.name ?? null, language: p["语言"]?.select?.name ?? null,
          version: plain(p["适用版本或车型"]),
          scenarios: (p["使用场景"]?.multi_select ?? []).map((x: any) => x.name),
          audience: (p["使用对象"]?.multi_select ?? []).map((x: any) => x.name),
          field: p["领域"]?.select?.name ?? null, keywords: plain(p["搜索关键词"]),
          doc_type: p["资料类型"]?.select?.name ?? null, exec_nature: p["执行性质"]?.select?.name ?? null,
          source_url: p["源链接"]?.url ?? null,
          last_review: p["最后审核"]?.date?.start?.slice(0, 10) ?? null,
        }),
      },
      projects: {
        table: "notion_projects", dbId: "4226f757-e9c9-812e-97e3-caddf180ffc2",
        map: (p) => ({
          title: plainTitle(p["项目名"]), customer: plain(p["客户/现场"]),
          stage: p["阶段"]?.status?.name ?? null,
          owner: p["项目负责人"]?.select?.name ?? null,
          start_date: p["项目开始"]?.date?.start?.slice(0, 10) ?? null,
          milestone: p["里程碑"]?.date?.start?.slice(0, 10) ?? null,
          note: plain(p["备注"]),
        }),
      },
      skills: {
        table: "notion_skills", dbId: "4236f757-e9c9-81fc-a6d6-cc9fddac2f6d",
        map: (p) => ({
          title: plainTitle(p["技能项"]), category: p["类别"]?.select?.name ?? null,
          seq: p["编号"]?.number ?? null,
          dongqi: p["Dongqi HE"]?.select?.name ?? null,
          xincheng: p["Xincheng YE"]?.select?.name ?? null,
          xian: p["Xian.ZOU"]?.select?.name ?? null,
          yuxing: p["Yuxing WANG"]?.select?.name ?? null,
          yuqi: p["Yuqi LIU(实习)"]?.select?.name ?? null,
          dian: p["Dian.QU(实习)"]?.select?.name ?? null,
          note: plain(p["备注"]),
        }),
      },
      attendance: {
        table: "notion_attendance", dbId: "4256f757-e9c9-818a-b310-000b76b65995",
        map: (p) => ({
          title: plainTitle(p["Name"]), person: p["人员"]?.select?.name ?? null,
          type: p["类型"]?.select?.name ?? null, place: plain(p["地点"]),
          start_date: p["开始日期"]?.date?.start?.slice(0, 10) ?? null,
          end_date: p["结束日期"]?.date?.start?.slice(0, 10) ?? null,
          status: p["状态"]?.status?.name ?? null, note: plain(p["备注"]),
        }),
      },
    };
    // plain/plainTitle 已提取到文件顶部（v10）
    if (url.searchParams.has("mirror") || action.startsWith("sync-")) {
      const key = action.startsWith("sync-") ? action.slice(5) : url.searchParams.get("mirror");
      const m = MIRRORS[key as string];
      if (!m) return J({ error: "unknown mirror: " + key }, 400);
      let cursor: string | undefined;
      const rows: any[] = [];
      while (true) {
        const res = await fetch(`https://api.notion.com/v1/databases/${m.dbId}/query`, {
          method: "POST", headers, body: JSON.stringify({ start_cursor: cursor, page_size: 100 }),
        });
        if (!res.ok) return J({ error: `notion_query ${res.status}: ${await res.text()}` }, 502);
        const data = await res.json();
        for (const page of data.results as any[]) {
          rows.push({ notion_page_id: page.id, ...m.map(page.properties ?? {}), page_url: page.url, last_edited: page.last_edited_time ?? null });
        }
        if (!data.has_more) break;
        cursor = data.next_cursor;
      }
      // 全量替换式 upsert
      const { error } = await sb.from(m.table).upsert(rows, { onConflict: "notion_page_id" });
      if (error) return J({ error: `upsert: ${error.message}` }, 500);
      return J({ ok: true, synced: rows.length });
    }

    // ---- v12: 拖拽改计划日期（今天要做↔近期要做），双写 Supabase + Notion ----
    if (action === "update-due") {
      const body = await req.json().catch(() => ({}));
      const { notion_page_id, due_date } = body; // due_date: "YYYY-MM-DD" 或 null（清空）
      if (!notion_page_id) return J({ error: "notion_page_id required" }, 400);
      if (due_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(due_date))) return J({ error: "due_date must be YYYY-MM-DD or null" }, 400);
      const props: any = {};
      if (due_date === null) props["预计完成"] = { date: null };
      else props["预计完成"] = { date: { start: String(due_date) } };
      const upd = await fetch(`https://api.notion.com/v1/pages/${notion_page_id}`, { method: "PATCH", headers, body: JSON.stringify({ properties: props }) });
      if (!upd.ok) return J({ error: `update_page ${upd.status}: ${await upd.text()}` }, 502);
      const { error: sbErr } = await sb.from("notion_issues").update({ due_date: due_date ?? null, last_synced: new Date().toISOString() }).eq("notion_page_id", notion_page_id);
      if (sbErr) return J({ error: `sb_update: ${sbErr.message}` }, 500);
      return J({ ok: true });
    }

    // ---- v9: 经验条目编辑写回 Notion（B 模式）----
    if (action === "update-experience") {
      const body = await req.json().catch(() => ({}));
      const { notion_page_id, title, detail, solution, note } = body;
      if (!notion_page_id) return J({ error: "notion_page_id required" }, 400);
      const props: any = {};
      if (title !== undefined) props["问题名称"] = { title: [{ text: { content: String(title) } }] };
      const setRich = (name: string, v: any) => { if (v !== undefined) props[name] = { rich_text: [{ text: { content: String(v ?? "") } }] }; };
      setRich("细节", detail); setRich("解决方案", solution); setRich("备注", note);
      const upd = await fetch(`https://api.notion.com/v1/pages/${notion_page_id}`, { method: "PATCH", headers, body: JSON.stringify({ properties: props }) });
      if (!upd.ok) return J({ error: `update_page ${upd.status}: ${await upd.text()}` }, 502);
      const patch: any = {};
      if (title !== undefined) patch.title = String(title);
      if (detail !== undefined) patch.detail = String(detail ?? "");
      if (solution !== undefined) patch.solution = String(solution ?? "");
      if (note !== undefined) patch.note = String(note ?? "");
      await sb.from("notion_experience").update({ ...patch, last_synced: new Date().toISOString() }).eq("notion_page_id", notion_page_id);
      return J({ ok: true });
    }

    // ---- v11: 项目编辑写回 Notion（B 模式）----
    if (action === "update-project") {
      const body = await req.json().catch(() => ({}));
      const { notion_page_id, stage, owner, customer, note } = body;
      if (!notion_page_id) return J({ error: "notion_page_id required" }, 400);
      const props: any = {};
      if (stage !== undefined) props["阶段"] = { status: { name: String(stage) } };
      if (owner !== undefined) props["项目负责人"] = { select: { name: String(owner) } };
      if (customer !== undefined) props["客户/现场"] = { rich_text: [{ text: { content: String(customer ?? "") } }] };
      if (note !== undefined) props["备注"] = { rich_text: [{ text: { content: String(note ?? "") } }] };
      const upd = await fetch(`https://api.notion.com/v1/pages/${notion_page_id}`, { method: "PATCH", headers, body: JSON.stringify({ properties: props }) });
      if (!upd.ok) return J({ error: `update_page ${upd.status}: ${await upd.text()}` }, 502);
      const patch: any = { last_synced: new Date().toISOString() };
      if (stage !== undefined) patch.stage = String(stage);
      if (owner !== undefined) patch.owner = String(owner);
      if (customer !== undefined) patch.customer = String(customer ?? "");
      if (note !== undefined) patch.note = String(note ?? "");
      await sb.from("notion_projects").update(patch).eq("notion_page_id", notion_page_id);
      return J({ ok: true });
    }

    return J({ error: "unknown action" }, 404);
  } catch (e) {
    return J({ error: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e) }, 500);
  }
});
