import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  compareSortIndex,
  extractFollowingTimelineArtifacts,
  extractProfileSnapshot,
  normalizeUserResult,
  parseDisplayedCount,
  toFiniteNonNegativeInt
} from "../x-following-exporter/shared/user-schema.js";
import { buildFilename, toCsv } from "../x-following-exporter/exporters/formatters.js";
import { renderDescriptionHtml, trimTrailingPunctuation } from "../x-following-exporter/exporters/description.js";
import { buildHtmlDocument } from "../x-following-exporter/exporters/html.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, "../x-following-exporter");

test("manifest.json is valid MV3 with MAIN world injection, sidePanel, and real icon paths", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes("sidePanel"));
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.permissions.includes("tabs"));
  assert.ok(manifest.permissions.includes("downloads"));
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.equal(manifest.background.service_worker, "background.js");

  const mainScript = manifest.content_scripts.find((cs) => cs.world === "MAIN");
  assert.ok(mainScript, "MAIN world content script must be declared");
  assert.equal(mainScript.run_at, "document_start");
  assert.deepEqual(mainScript.js, ["page-bridge.js"]);

  for (const relPath of [
    manifest.side_panel.default_path,
    manifest.background.service_worker,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((cs) => cs.js)
  ]) {
    assert.ok(fs.existsSync(path.join(EXT_DIR, relPath)), `Referenced file missing: ${relPath}`);
  }
});

test("toFiniteNonNegativeInt never coerces null or empty string to 0", () => {
  assert.equal(toFiniteNonNegativeInt(null), null);
  assert.equal(toFiniteNonNegativeInt(undefined), null);
  assert.equal(toFiniteNonNegativeInt(""), null);
  assert.equal(toFiniteNonNegativeInt(-5), null);
  assert.equal(toFiniteNonNegativeInt("abc"), null);
  assert.equal(toFiniteNonNegativeInt(0), 0);
  assert.equal(toFiniteNonNegativeInt("42"), 42);
});

test("normalizeUserResult supports July 2026 legacy-free User schema and legacy fallback", () => {
  const modern2026User = {
    __typename: "User",
    rest_id: "10001",
    is_blue_verified: true,
    core: {
      name: "Alice 2026",
      screen_name: "alice2026",
      created_at: "Tue Jan 01 00:00:00 +0000 2024"
    },
    profile_bio: {
      description: "Building things at https://t.co/abc123",
      entities: {
        description: {
          urls: [
            {
              url: "https://t.co/abc123",
              expanded_url: "https://example.com/project?a=1&b=2",
              display_url: "example.com/project"
            }
          ]
        },
        url: {
          urls: [
            {
              url: "https://t.co/site",
              expanded_url: "https://alice.dev",
              display_url: "alice.dev"
            }
          ]
        }
      }
    },
    website: { url: "https://t.co/site" },
    relationship_counts: { followers: 12345, following: 321 },
    tweet_counts: { tweets: 888, media_tweets: 42 },
    action_counts: { favorites_count: 999 },
    dm_permissions: { can_dm: true },
    privacy: { protected: true },
    relationship_perspectives: { following: true, followed_by: true },
    verification: { verified: true, verified_type: "Business" },
    location: { location: "Tokyo" },
    avatar: { image_url: "https://pbs.twimg.com/profile_images/1/pic_normal.jpg?name=small&v=2" },
    banner: { image_url: "https://pbs.twimg.com/profile_banners/10001/1700000000" },
    professional: { rest_id: "pro_1" }
  };

  const parsed = normalizeUserResult(modern2026User, "9007199254740995");
  assert.equal(parsed.name, "Alice 2026");
  assert.equal(parsed.username, "alice2026");
  assert.equal(parsed.user_id, "10001");
  assert.equal(parsed.description, "Building things at https://t.co/abc123");
  assert.equal(parsed.website, "https://alice.dev");
  assert.equal(parsed.followers_count, 12345);
  assert.equal(parsed.following_count, 321);
  assert.equal(parsed.posts_count, 888);
  assert.equal(parsed.media_count, 42);
  assert.equal(parsed.favourites_count, 999);
  assert.equal(parsed.listed_count, null);
  assert.equal(parsed.can_dm, true);
  assert.equal(parsed.protected, true);
  assert.equal(parsed.followed_by, true);
  assert.equal(parsed.verified_type, "Business");
  assert.equal(parsed.banner_url, "https://pbs.twimg.com/profile_banners/10001/1700000000");
  assert.equal(parsed.description_urls.length, 1);
  assert.equal(parsed.description_urls[0].expanded_url, "https://example.com/project?a=1&b=2");

  const unavailable = normalizeUserResult({
    __typename: "UserUnavailable",
    reason: "Suspended"
  });
  assert.deepEqual(unavailable, { __unavailable: true, reason: "Suspended" });

  const legacyUser = {
    rest_id: "20002",
    legacy: {
      name: "Legacy Bob",
      screen_name: "legacybob",
      description: "Old schema",
      followers_count: 50,
      friends_count: 10,
      listed_count: 3,
      statuses_count: 100
    }
  };
  const parsedLegacy = normalizeUserResult(legacyUser);
  assert.equal(parsedLegacy.username, "legacybob");
  assert.equal(parsedLegacy.followers_count, 50);
  assert.equal(parsedLegacy.following_count, 10);
  assert.equal(parsedLegacy.listed_count, 3);
});

test("extractFollowingTimelineArtifacts sorts entries by BigInt sortIndex descending", () => {
  const payload = {
    data: {
      user: {
        result: {
          timeline: {
            timeline: {
              instructions: [
                {
                  type: "TimelineAddEntries",
                  entries: [
                    {
                      entryId: "user-1",
                      sortIndex: "1800000000000000001",
                      content: {
                        itemContent: {
                          user_results: { result: { rest_id: "1", core: { screen_name: "older" } } }
                        }
                      }
                    },
                    {
                      entryId: "user-2",
                      sortIndex: "1800000000000000999",
                      content: {
                        itemContent: {
                          user_results: { result: { rest_id: "2", core: { screen_name: "newer" } } }
                        }
                      }
                    },
                    {
                      entryId: "cursor-bottom-1",
                      sortIndex: "0",
                      content: {
                        entryType: "TimelineTimelineCursor",
                        cursorType: "Bottom",
                        value: "CURSOR_NEXT_123"
                      }
                    }
                  ]
                }
              ]
            }
          }
        }
      }
    }
  };

  assert.equal(compareSortIndex("1800000000000000001", "1800000000000000999"), 1);
  const artifacts = extractFollowingTimelineArtifacts(payload);
  assert.equal(artifacts.bottomCursor, "CURSOR_NEXT_123");
  assert.deepEqual(
    artifacts.userEntries.map((u) => u.result.core.screen_name),
    ["newer", "older"]
  );
});

test("extractProfileSnapshot and parseDisplayedCount handle modern counts and units", () => {
  const profilePayload = {
    data: {
      user: {
        result: {
          __typename: "User",
          rest_id: "777",
          core: { screen_name: "TargetUser" },
          relationship_counts: { followers: 500, following: 237 }
        }
      }
    }
  };
  const snap = extractProfileSnapshot(profilePayload);
  assert.equal(snap.username, "TargetUser");
  assert.equal(snap.usernameLower, "targetuser");
  assert.equal(snap.userId, "777");
  assert.equal(snap.followingCount, 237);

  assert.equal(parseDisplayedCount("1,234 Following"), 1234);
  assert.equal(parseDisplayedCount("2.5万 正在关注"), 25000);
});

test("renderDescriptionHtml expands t.co, trims CJK punctuation, and ignores Node.js filenames", () => {
  assert.equal(trimTrailingPunctuation("https://example.com，"), "https://example.com");

  const html = renderDescriptionHtml(
    "使用 Node.js 与 v2.0.rc，主页 https://t.co/xyz，欢迎关注 @alice_dev！",
    [
      {
        url: "https://t.co/xyz",
        expanded_url: "https://example.org/docs?a=1&b=2",
        display_url: "example.org/docs"
      }
    ]
  );

  assert.ok(!html.includes("https://Node.js"), "Node.js must not become a link");
  assert.ok(!html.includes("https://v2.0.rc"), "Version token must not become a link");
  assert.ok(
    html.includes('href="https://example.org/docs?a=1&amp;b=2"'),
    "t.co must expand with single HTML attribute escaping"
  );
  assert.ok(!html.includes("&amp;amp;"), "Must not double-escape query ampersands");
  assert.ok(html.includes(">example.org/docs</a>，"), "Chinese comma must stay outside anchor");
  assert.ok(html.includes('href="https://x.com/alice_dev"'), "@mention must link to X profile");
});

test("buildHtmlDocument prevents double-escaping on avatar_url and renders accessible table semantics", () => {
  const html = buildHtmlDocument({
    pageUsername: "Owner",
    mode: "direct-complete",
    exportedAt: "2026-11-26T00:00:00.000Z",
    count: 1,
    unavailableCount: 2,
    users: [
      {
        name: "A & B",
        username: "ab_user",
        user_id: "99",
        description: "hi <script>alert(1)</script>",
        description_urls: [],
        website: "https://site.example/?x=1&y=2",
        created_at: "2024",
        followers_count: 100,
        following_count: 50,
        followed_by: true,
        protected: true,
        blue_verified: true,
        verified_type: "Business",
        avatar_url: "https://pbs.twimg.com/img.jpg?format=jpg&name=small",
        profile_url: "https://x.com/ab_user"
      }
    ]
  });

  assert.ok(
    html.includes('src="https://pbs.twimg.com/img.jpg?format=jpg&amp;name=small"'),
    "avatar_url must be escaped exactly once"
  );
  assert.ok(!html.includes("&amp;amp;"), "No double-escaped entities allowed");
  assert.ok(!html.includes("<script>alert(1)</script>"), "User bio script tag must be escaped");
  assert.ok(html.includes('tabindex="0" role="region" aria-labelledby="table-heading"'));
  assert.ok(html.includes("border-collapse: separate;"));
  assert.ok(html.includes("互关"));
  assert.ok(html.includes("锁推"));
  assert.ok(html.includes("金标"));
  assert.ok(html.includes("另有 2 个已封禁/不可用账号"));
});

test("toCsv escapes CR/LF, commas, quotes and includes UTF-8 BOM", () => {
  const csv = toCsv([
    {
      name: 'He said "hi"\r\nnext',
      username: "u1",
      user_id: "1",
      description: "a,b",
      website: "",
      created_at: "",
      followers_count: 1,
      following_count: 2,
      favourites_count: 0,
      listed_count: null,
      media_count: 0,
      posts_count: 0,
      can_dm: false,
      protected: false,
      followed_by: null,
      following: true,
      verified: false,
      verified_type: "",
      blue_verified: false,
      professional: false,
      location: "",
      avatar_url: "",
      banner_url: "",
      profile_url: "https://x.com/u1"
    }
  ]);

  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes('"He said ""hi""\r\nnext"'));
  assert.ok(csv.includes('"a,b"'));
  assert.match(buildFilename({ pageUsername: "a/b:c", count: 5 }, "html", "offline"), /^x-following-a_b_c-5-.*-offline\.html$/);
});

function createBridgeSandbox(initialPath = "/Alice/following", fetchImpl = null) {
  const listeners = new Map();
  const statusMessages = [];
  const responseWaiters = new Map();

  const locationObj = {
    origin: "https://x.com",
    pathname: initialPath,
    href: "https://x.com" + initialPath
  };

  const mockAnchors = [];
  const windowObj = {
    location: locationObj,
    history: {
      pushState(_state, _title, url) {
        locationObj.pathname = url;
        locationObj.href = locationObj.origin + url;
      },
      replaceState(_state, _title, url) {
        locationObj.pathname = url;
        locationObj.href = locationObj.origin + url;
      }
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    postMessage(data) {
      if (data && data.source === "XFE_PAGE" && data.type === "status") {
        statusMessages.push(data.payload);
      } else if (data && data.source === "XFE_PAGE" && data.type === "response") {
        const waiter = responseWaiters.get(data.requestId);
        if (waiter) {
          responseWaiters.delete(data.requestId);
          waiter(data);
        }
      }
    },
    scrollTo() {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: fetchImpl || (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
    XMLHttpRequest: class MockXHR {
      open() {}
      setRequestHeader() {}
      addEventListener() {}
      send() {}
    }
  };

  const documentObj = {
    body: { scrollHeight: 1000 },
    querySelectorAll(selector) {
      if (selector === 'a[href*="/following"]') {
        return mockAnchors;
      }
      return [];
    }
  };

  const context = vm.createContext({
    window: windowObj,
    document: documentObj,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    AbortController,
    BigInt,
    console
  });

  const code = fs.readFileSync(path.join(EXT_DIR, "page-bridge.js"), "utf8");
  vm.runInContext(code, context, { filename: "page-bridge.js" });

  function sendCommand(command, payload = {}) {
    const requestId = "req_" + Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      responseWaiters.set(requestId, resolve);
      for (const fn of listeners.get("message") || []) {
        fn({
          source: windowObj,
          origin: "https://x.com",
          data: {
            source: "XFE_CONTENT",
            type: "command",
            requestId,
            command,
            payload
          }
        });
      }
    });
  }

  return { windowObj, mockAnchors, statusMessages, sendCommand };
}

test("page-bridge isolates SPA account switch, ignores non-Following user_results, and fixes Number(null)", async () => {
  const fetchMock = async (url) => {
    if (String(url).includes("/UserByScreenName")) {
      return new Response(
        JSON.stringify({
          data: {
            user: {
              result: {
                __typename: "User",
                rest_id: "111",
                core: { screen_name: "Alice" },
                relationship_counts: { following: 42 }
              }
            }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (String(url).includes("/ConnectTabTimeline")) {
      return new Response(
        JSON.stringify({
          data: {
            timeline: {
              instructions: [
                {
                  type: "TimelineAddEntries",
                  entries: [
                    {
                      entryId: "user-999",
                      content: {
                        itemContent: {
                          user_results: {
                            result: { rest_id: "999", core: { screen_name: "spam_rec" } }
                          }
                        }
                      }
                    }
                  ]
                }
              ]
            }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (String(url).includes("/Following")) {
      // Simulate 404 on direct fetch (e.g. transaction-id check) after initial seed capture
      return new Response("", { status: 404, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  let callIndex = 0;
  const { windowObj, sendCommand } = createBridgeSandbox("/Alice/following", async (url, init) => {
    if (String(url).includes("/Following") && callIndex === 0) {
      callIndex += 1;
      return new Response(
        JSON.stringify({
          data: {
            user: {
              result: {
                timeline: {
                  timeline: {
                    instructions: [
                      {
                        type: "TimelineAddEntries",
                        entries: [
                          {
                            entryId: "user-501",
                            sortIndex: "200",
                            content: {
                              itemContent: {
                                user_results: {
                                  result: {
                                    __typename: "User",
                                    rest_id: "501",
                                    core: { name: "Followed One", screen_name: "followed_one" },
                                    relationship_counts: { followers: 10, following: 5 }
                                  }
                                }
                              }
                            }
                          }
                        ]
                      }
                    ]
                  }
                }
              }
            }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return fetchMock(url, init);
  });

  // 1. Intercept UserByScreenName
  await windowObj.fetch("https://x.com/i/api/graphql/qid1/UserByScreenName?variables=%7B%7D");
  await new Promise((r) => setTimeout(r, 20));
  const known = await sendCommand("getKnownProfileCount");
  assert.equal(known.ok, true);
  assert.equal(known.payload.followingCount, 42);
  assert.equal(known.payload.userId, "111");

  // 2. Non-Following response with user_results must be ignored
  await windowObj.fetch("https://x.com/i/api/graphql/qid2/ConnectTabTimeline?variables=%7B%7D");
  await new Promise((r) => setTimeout(r, 20));
  const statusAfterNoise = await sendCommand("getStatus");
  assert.equal(statusAfterNoise.payload.count, 0);
  assert.equal(statusAfterNoise.payload.seedCaptured, false);

  // 3. Intercept Alice's Following seed
  await windowObj.fetch(
    'https://x.com/i/api/graphql/qid3/Following?variables=' + encodeURIComponent(JSON.stringify({ userId: "111" })),
    { headers: { authorization: "Bearer test" } }
  );
  await new Promise((r) => setTimeout(r, 20));
  const statusAfterSeed = await sendCommand("getStatus");
  assert.equal(statusAfterSeed.payload.seedCaptured, true);

  // 4. Start export with expectedFollowingCount: null -> must NOT turn into 0, and HTTP 404 must degrade to direct-stalled-scroll
  const startRes = await sendCommand("startExport", {
    profileUsername: "Alice",
    expectedFollowingCount: null,
    profileCheckError: "simulated timeout"
  });
  assert.equal(startRes.ok, true);
  await new Promise((r) => setTimeout(r, 50));

  const statusAfter404 = await sendCommand("getStatus");
  assert.equal(statusAfter404.payload.profileCheck.status, "idle");
  assert.equal(statusAfter404.payload.profileCheck.expectedFollowingCount, null);
  assert.equal(statusAfter404.payload.mode, "direct-stalled-scroll");
  assert.equal(statusAfter404.payload.count, 1, "Matching cache should be replayed on 404 fallback");

  // Stop scroll timer before switching accounts
  await sendCommand("stopExport");

  // 5. SPA switch to /Bob/following must reset Alice's seed & users
  windowObj.history.pushState({}, "", "/Bob/following");
  const statusAfterSwitch = await sendCommand("getStatus");
  assert.equal(statusAfterSwitch.payload.pageUsername, "Bob");
  assert.equal(statusAfterSwitch.payload.seedCaptured, false);
  assert.equal(statusAfterSwitch.payload.count, 0);

  // 6. Restore session rejects mismatched account and accepts matching account
  const badRestore = await sendCommand("restoreSession", {
    pageUsername: "Alice",
    users: [{ username: "followed_one", user_id: "501" }]
  });
  assert.equal(badRestore.ok, false);

  const okRestore = await sendCommand("restoreSession", {
    pageUsername: "bob",
    lastCursor: "CUR_BOB_1",
    done: false,
    users: [{ username: "bob_friend", user_id: "801" }]
  });
  assert.equal(okRestore.ok, true);
  assert.equal(okRestore.payload.count, 1);
  assert.equal(okRestore.payload.hasCursor, true);

  // 7. Pause & Stop transitions work cleanly after resume
  const resumeRes = await sendCommand("resumeExport");
  assert.equal(resumeRes.ok, true);
  const pauseRes = await sendCommand("pauseExport");
  assert.equal(pauseRes.ok, true);
  assert.equal(pauseRes.payload.paused, true);
  const stopRes = await sendCommand("stopExport");
  assert.equal(stopRes.ok, true);
  assert.equal(stopRes.payload.count, 1);
});

test("page-bridge getProfileFollowingCount matches username case-insensitively on profile page", async () => {
  const { mockAnchors, sendCommand } = createBridgeSandbox("/alice");
  mockAnchors.push({
    href: "https://x.com/Alice/following",
    textContent: "1,234 Following",
    getAttribute: () => ""
  });

  const res = await sendCommand("getProfileFollowingCount");
  assert.equal(res.ok, true);
  assert.equal(res.payload.followingCount, 1234);
  assert.equal(res.payload.source, "profile-link");
});
