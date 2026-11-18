"""配件大亂鬥 (Gear Brawl) 伺服器。

只用 Python 標準函式庫：同時提供網頁靜態檔與 WebSocket 連線，
並以伺服器權威 (server-authoritative) 方式跑遊戲邏輯，每秒 60 次模擬、20 次廣播。

啟動：python server.py   (可用環境變數 PORT 指定埠號，預設 8765)
"""

import asyncio
import base64
import hashlib
import json
import math
import os
import random
import socket
import struct
import time
from pathlib import Path

HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8765"))
PUBLIC = (Path(__file__).parent / "public").resolve()

TICK = 60
DT = 1 / TICK
SEND_INTERVAL = 1 / 30  # 30 次/秒廣播
MATCH_SECONDS = 180
RESULT_SECONDS = 8
MAX_BOTS = 5

# ------------------------------------------------------------------ 地圖
MAP = {
    "name": "浮空競技場",
    "w": 1400,
    "h": 900,
    "platform": {"x": 150, "y": 130, "w": 1100, "h": 640},
    "pillars": [
        {"x": 400, "y": 290, "w": 90, "h": 70, "hgt": 56},
        {"x": 910, "y": 290, "w": 90, "h": 70, "hgt": 56},
        {"x": 400, "y": 540, "w": 90, "h": 70, "hgt": 56},
        {"x": 910, "y": 540, "w": 90, "h": 70, "hgt": 56},
    ],
    "spawns": [
        [260, 240], [1140, 240], [260, 660], [1140, 660],
        [700, 220], [700, 680], [560, 450], [840, 450],
    ],
    "crates": [[700, 340], [700, 560], [270, 450], [1130, 450]],
}

# ------------------------------------------------------------------ 角色參數
R = 22              # 角色半徑
SPEED = 230         # 移動速度 px/s
JUMP_V = 430        # 起跳速度
GRAV = 1300         # 重力
MAX_HP = 100
KEYS = ("u", "d", "l", "r", "z", "x", "c", "v")

# 按鍵配置：V 跳、X 輕攻擊、C 重攻擊、Z 瞄準、X+C 防禦、Z+X+C 大絕
CHORD_WAIT = 0.05   # 按下 X 或 C 後等多久判斷是不是組合鍵

# 配件：X 輕攻擊(zdmg/zrange/zspeed)、C 重攻擊(cdmg/crange)、大絕冷卻(vcd)、電腦放大絕的距離(reach)
GEARS = {
    "flame": {"name": "炎拳手套", "zdmg": (7, 7, 12), "zrange": 50, "zspeed": 1.0,
              "cdmg": 16, "crange": 56, "vcd": 3.0, "reach": 110},
    "staff": {"name": "疾風長棍", "zdmg": (5, 6, 10), "zrange": 80, "zspeed": 0.88,
              "cdmg": 13, "crange": 90, "vcd": 4.0, "reach": 110},
    "blaster": {"name": "雷光砲", "zdmg": (5, 5, 9), "zrange": 48, "zspeed": 1.1,
                "cdmg": 12, "crange": 62, "vcd": 1.4, "reach": 300},
    "greatsword": {"name": "巨劍", "zdmg": (8, 8, 14), "zrange": 74, "zspeed": 0.78,
                   "cdmg": 20, "crange": 82, "vcd": 5.0, "reach": 170},
    "axe": {"name": "戰斧", "zdmg": (7, 7, 11), "zrange": 58, "zspeed": 0.95,
            "cdmg": 15, "crange": 62, "vcd": 3.0, "reach": 260},
    "dagger": {"name": "影匕首", "zdmg": (3, 3, 3, 4, 7), "zrange": 42, "zspeed": 1.35,
               "cdmg": 10, "crange": 46, "vcd": 3.5, "reach": 280,
               # 五段連擊：前四段快速輕刺，第五段擊倒
               "combo": ((0.05, 0.11, 0.20, 90, 0, 0.34),
                         (0.05, 0.11, 0.20, 90, 0, 0.34),
                         (0.05, 0.11, 0.20, 90, 0, 0.34),
                         (0.05, 0.11, 0.22, 110, 0, 0.36),
                         (0.08, 0.16, 0.34, 460, 210, 0.5))},
    "wand": {"name": "冰霜魔杖", "zdmg": (4, 5, 8), "zrange": 50, "zspeed": 1.05,
             "cdmg": 11, "crange": 56, "vcd": 4.5, "reach": 110},
}
LEAP_RADIUS = 105    # 巨劍「破山斬」落地衝擊波半徑
NOVA_RADIUS = 120    # 冰霜魔杖「冰霜新星」範圍
FREEZE_TIME = 1.2    # 冰凍秒數
BLINK_RANGE = 300    # 影匕首「影襲」可瞬移的最遠距離
AXE_OUT = 0.45       # 飛斧去程秒數（之後折返）
CHARGE_MAX = 1.2     # 巨劍重攻擊最長蓄力秒數（蓄滿傷害 2 倍）
# 重攻擊：(判定開始, 判定結束, 總長度, 擊退, 擊飛, 硬直)
HEAVY = (0.24, 0.34, 0.62, 560, 260, 0.6)
# 三段普攻：(判定開始, 判定結束, 總長度, 擊退, 擊飛, 硬直)
COMBO = (
    (0.08, 0.16, 0.30, 150, 0, 0.36),
    (0.08, 0.16, 0.30, 150, 0, 0.36),
    (0.12, 0.22, 0.44, 500, 230, 0.5),
)


def clamp(v, lo, hi):
    """把數值限制在 lo~hi 之間。"""
    return lo if v < lo else hi if v > hi else v


def on_platform(x, y):
    """判斷座標是否站在平台上（離開平台落地就會掉下去）。"""
    p = MAP["platform"]
    return p["x"] <= x <= p["x"] + p["w"] and p["y"] <= y <= p["y"] + p["h"]


def ground_z(x, y):
    """回傳該位置的地面高度：站在柱子頂上就是柱子高度，其他地方是 0。"""
    for r in MAP["pillars"]:
        if r["x"] <= x <= r["x"] + r["w"] and r["y"] <= y <= r["y"] + r["h"]:
            return r["hgt"]
    return 0.0


def grounded(p):
    """角色是否踩在地面或柱子頂上（不在空中）。"""
    return p.z <= ground_z(p.x, p.y) + 0.01 and p.vz <= 0


def hits_pillar(x, y, rad, z=0.0):
    """判斷圓形是否與任一柱子重疊（給飛行物用）；高度超過柱頂就飛得過去。"""
    for r in MAP["pillars"]:
        if z >= r["hgt"]:
            continue
        cx = clamp(x, r["x"], r["x"] + r["w"])
        cy = clamp(y, r["y"], r["y"] + r["h"])
        if (x - cx) ** 2 + (y - cy) ** 2 < rad * rad:
            return True
    return False


# ------------------------------------------------------------------ 遊戲物件
class Player:
    """一名玩家（真人或電腦）的完整狀態。"""

    def __init__(self, pid, name, color, gear, bot=False):
        """建立玩家並立即出生在場上。"""
        self.id = pid
        self.name = name
        self.color = color
        self.gear = gear
        self.bot = bot
        self.ch = ""  # 外觀角色代號（空字串 = 由前端依 id 分配）
        self.inp = dict.fromkeys(KEYS, False)
        self.latch = dict.fromkeys(KEYS, False)  # 這一格內「剛按下」的鍵，避免快速點擊被漏掉
        self.kos = 0
        self.deaths = 0
        self.ai = {"guard": 0.0}
        self.spawn()

    def spawn(self):
        """重生：回滿血、給無敵時間、挑一個離其他人最遠的出生點。"""
        others = [q for q in game.players.values() if q is not self and q.state != "dead"] if game else []
        best, best_d = None, -1
        spots = MAP["spawns"][:]
        random.shuffle(spots)
        for sx, sy in spots:
            d = min((math.hypot(sx - q.x, sy - q.y) for q in others), default=9999)
            if d > best_d:
                best, best_d = (sx, sy), d
        self.x, self.y = best
        self.z = 0.0
        self.vz = 0.0
        self.kvx = self.kvy = 0.0
        cx = MAP["platform"]["x"] + MAP["platform"]["w"] / 2
        self.fx, self.fy = (1.0, 0.0) if self.x < cx else (-1.0, 0.0)
        self.hp = MAX_HP
        self.state = "idle"
        self.t = 0.0
        self.dur = 0.0
        self.combo = 0
        self.queued = False
        self.hitset = set()
        self.holding = None
        self.vcd = 0.0
        self.inv = 2.0
        self.ko_pending = False
        self.last_hit_by = None
        self.last_hit_at = -99.0
        self.moving = False
        self.nova_done = False
        self.charge_k = 0.0                # 巨劍蓄力倍率（0~1）
        self.pend_x = self.pend_c = False  # 等待組合鍵判斷中的 X / C
        self.chord_t = 0.0
        self.aim = None                    # Z 鎖定中的目標 id

    @property
    def alive(self):
        """是否還在場上可被攻擊/互動。"""
        return self.state not in ("dead", "falling")


class Crate:
    """場上的木箱，可撿起來丟人。"""

    def __init__(self, cid, x, y):
        """在固定位置建立木箱。"""
        self.id = cid
        self.home = (x, y)
        self.reset()

    def reset(self):
        """回到原位重新出現。"""
        self.x, self.y = self.home
        self.z = 0.0
        self.state = "ground"  # ground / held / fly / gone
        self.vx = self.vy = 0.0
        self.owner = None
        self.t = 0.0


class Game:
    """整場遊戲的世界狀態與每格更新邏輯。"""

    def __init__(self):
        """初始化空場地。"""
        self.players = {}
        self.crates = [Crate(i, x, y) for i, (x, y) in enumerate(MAP["crates"])]
        self.projs = []
        self.fx = []
        self.next_id = 1
        self.now = 0.0
        self.phase = "play"
        self.time_left = MATCH_SECONDS
        self.result_t = 0.0

    def new_id(self):
        """產生不重複的物件 id。"""
        self.next_id += 1
        return self.next_id

    def event(self, kind, **kw):
        """記錄一個給前端播特效/訊息用的事件。"""
        kw["k"] = kind
        self.fx.append(kw)

    # ---------------------------------------------------- 移動與碰撞
    def move(self, p, dx, dy):
        """移動角色並推出柱子與地圖邊界；高度已經在柱頂以上就不擋（可以跳上去站）。"""
        p.x = clamp(p.x + dx, 0, MAP["w"])
        p.y = clamp(p.y + dy, 0, MAP["h"])
        for r in MAP["pillars"]:
            if p.z >= r["hgt"] - 2:
                continue
            cx = clamp(p.x, r["x"], r["x"] + r["w"])
            cy = clamp(p.y, r["y"], r["y"] + r["h"])
            ex, ey = p.x - cx, p.y - cy
            d2 = ex * ex + ey * ey
            if d2 >= R * R:
                continue
            if d2 > 0:
                d = math.sqrt(d2)
                p.x, p.y = cx + ex / d * R, cy + ey / d * R
            else:  # 中心點陷進柱子內：沿最短邊推出
                opts = [
                    (p.x - r["x"], -1, 0), (r["x"] + r["w"] - p.x, 1, 0),
                    (p.y - r["y"], 0, -1), (r["y"] + r["h"] - p.y, 0, 1),
                ]
                dist, sx, sy = min(opts)
                p.x += sx * (dist + R)
                p.y += sy * (dist + R)

    def separate(self):
        """讓角色之間不要重疊（互相推開）。"""
        ps = [p for p in self.players.values() if p.alive]
        for i in range(len(ps)):
            for j in range(i + 1, len(ps)):
                a, b = ps[i], ps[j]
                if abs(a.z - b.z) > 30:
                    continue
                dx, dy = b.x - a.x, b.y - a.y
                d = math.hypot(dx, dy)
                if 0 < d < 2 * R:
                    push = (2 * R - d) / 2
                    nx, ny = dx / d, dy / d
                    self.move(a, -nx * push, -ny * push)
                    self.move(b, nx * push, ny * push)

    # ---------------------------------------------------- 狀態切換
    def set_state(self, p, st, dur=0.0):
        """切換角色狀態並重設計時。"""
        p.state = st
        p.t = 0.0
        p.dur = dur
        if st != "idle":  # 被打斷時取消還沒判斷完的組合鍵
            p.pend_x = p.pend_c = False
            p.chord_t = 0.0

    def start_attack(self, p, n):
        """開始第 n 段普攻（一般三段，影匕首五段）。"""
        g = GEARS[p.gear]
        self.set_state(p, "attack", g.get("combo", COMBO)[n][2] / g["zspeed"])
        p.combo = n
        p.queued = False
        p.hitset = set()

    def start_special(self, p):
        """發動配件特技（V）。"""
        g = GEARS[p.gear]
        p.vcd = g["vcd"]
        p.hitset = set()
        if p.gear == "flame":
            self.set_state(p, "dash", 0.32)
            self.event("dash", id=p.id)
        elif p.gear == "staff":
            self.set_state(p, "spin", 0.55)
            self.event("spin", id=p.id)
        elif p.gear == "greatsword":  # 破山斬：往前跳起，落地衝擊波
            self.set_state(p, "leap", 2.0)
            p.vz = 440
            p.kvx, p.kvy = p.fx * 360, p.fy * 360
        elif p.gear == "axe":  # 迴旋飛斧：丟出去再飛回來
            self.spawn_proj(p, "axe", 620, dmg=9, kb=300, stun=0.45, out=AXE_OUT)
            self.set_state(p, "recover", 0.3)
        elif p.gear == "dagger":  # 影襲：瞬移到最近敵人背後背刺
            self.start_blink(p)
        elif p.gear == "wand":  # 冰霜新星：短暫詠唱後周圍冰凍
            self.set_state(p, "nova", 0.5)
            p.nova_done = False
        else:
            self.spawn_proj(p, "bolt", 640, dmg=10, kb=300, stun=0.45, life=1.2)
            self.set_state(p, "recover", 0.25)
            self.event("shot", id=p.id, x=round(p.x + p.fx * 30), y=round(p.y + p.fy * 30))

    def start_blink(self, p):
        """影襲：找最近的敵人，瞬移到他背後（站不住就換到另一側），沒有目標就往前閃。"""
        tgt = self.aim_target(p)
        if tgt and math.hypot(tgt.x - p.x, tgt.y - p.y) <= BLINK_RANGE:
            dx, dy = tgt.x - p.x, tgt.y - p.y
            d = math.hypot(dx, dy) or 1
            spots = [(tgt.x - tgt.fx * 40, tgt.y - tgt.fy * 40), (tgt.x + dx / d * 40, tgt.y + dy / d * 40)]
            spot = next((s for s in spots if on_platform(*s)), None)
            if spot:
                self.event("blink", x=round(p.x), y=round(p.y), x2=round(spot[0]), y2=round(spot[1]))
                p.x, p.y = spot
                self.move(p, 0, 0)
                fx, fy = tgt.x - p.x, tgt.y - p.y
                n = math.hypot(fx, fy) or 1
                p.fx, p.fy = fx / n, fy / n
                self.set_state(p, "stab", 0.4)
                p.hitset = set()
                return
        # 沒有目標：往前小閃避
        self.event("blink", x=round(p.x), y=round(p.y), x2=round(p.x + p.fx * 120), y2=round(p.y + p.fy * 120))
        self.move(p, p.fx * 120, p.fy * 120)
        self.set_state(p, "recover", 0.2)

    def freeze(self, att, vic):
        """冰凍：目標 1.2 秒不能動作（再被打會解凍並正常受擊）。"""
        if not vic.alive or vic.state in ("down", "frozen") or vic.inv > 0:
            return
        vic.hp = max(0, vic.hp - 8)
        vic.last_hit_by, vic.last_hit_at = att.id, self.now
        self.drop_crate(vic)
        vic.kvx = vic.kvy = 0.0
        if vic.hp <= 0:
            vic.ko_pending = True
            self.set_state(vic, "down", 1.1)
        else:
            self.set_state(vic, "frozen", FREEZE_TIME)
        self.event("freeze", x=round(vic.x), y=round(vic.y))

    def drop_crate(self, p):
        """被打中或倒下時把手上的木箱掉在地上。"""
        if p.holding is None:
            return
        c = self.crates[p.holding]
        p.holding = None
        c.owner = None
        c.z = 0
        if on_platform(p.x, p.y):
            c.state, c.x, c.y = "ground", p.x, p.y
        else:
            c.state, c.t = "gone", 0.0

    def do_ko(self, p):
        """角色被 KO（血量歸零或掉出場外）：結算得分並進入等待重生。"""
        p.deaths += 1
        killer = self.players.get(p.last_hit_by)
        recent = self.now - p.last_hit_at < 8
        if killer and killer is not p and recent:
            killer.kos += 1
            self.event("ko", name=p.name, by=killer.name, color=killer.color)
        else:
            self.event("ko", name=p.name, by=None, color=p.color)
        self.drop_crate(p)
        p.ko_pending = False
        p.kvx = p.kvy = 0
        self.set_state(p, "dead", 3.0)

    # ---------------------------------------------------- 攻擊判定
    def hit(self, att, vic, dmg, dx, dy, kb, launch, stun, guard_break=False):
        """處理一次命中：防禦、扣血、擊退、倒地與 KO。回傳是否有效命中。"""
        if not vic.alive or vic.state == "down" or vic.inv > 0:
            return False
        if vic.state == "guard" and vic.fx * -dx + vic.fy * -dy > 0.0:
            vic.last_hit_by, vic.last_hit_at = (att.id if att else None), self.now
            if guard_break:
                self.set_state(vic, "guardbreak", 1.0)
                self.event("gb", x=round(vic.x), y=round(vic.y))
            else:
                vic.hp = max(1, vic.hp - max(1, round(dmg * 0.15)))
                vic.kvx, vic.kvy = dx * kb * 0.35, dy * kb * 0.35
                self.event("block", x=round(vic.x + -dx * 0 + vic.fx * 20), y=round(vic.y + vic.fy * 20), z=round(vic.z + 20))
            return True
        vic.hp -= dmg
        self.drop_crate(vic)
        if att:
            vic.last_hit_by, vic.last_hit_at = att.id, self.now
        vic.kvx, vic.kvy = dx * kb, dy * kb
        if launch:
            vic.vz = max(vic.vz, launch)
        vic.fx, vic.fy = -dx, -dy
        heavy = kb >= 400 or launch > 0
        if vic.hp <= 0:
            vic.hp = 0
            vic.ko_pending = True
            self.set_state(vic, "down", 1.1)
        elif heavy:
            self.set_state(vic, "down", 0.85)
        else:
            self.set_state(vic, "hitstun", stun)
        self.event("hit", x=round(vic.x), y=round(vic.y), z=round(vic.z + 20), heavy=heavy, dmg=dmg)
        return True

    def melee(self, p, rng, arc, dmg, kb, launch, stun, radial=False, guard_break=False):
        """以角色為中心做近戰判定，每個目標在同一招只會被打一次。"""
        for q in self.players.values():
            if q is p or q.id in p.hitset or not q.alive:
                continue
            dx, dy = q.x - p.x, q.y - p.y
            d = math.hypot(dx, dy)
            if d > rng + R or abs(q.z - p.z) > 45:
                continue
            if d > R and (dx * p.fx + dy * p.fy) / d < arc:
                continue
            p.hitset.add(q.id)
            if radial and d > 0:
                nx, ny = dx / d, dy / d
            else:
                nx, ny = p.fx, p.fy
            self.hit(p, q, dmg, nx, ny, kb, launch, stun, guard_break)

    # ---------------------------------------------------- 每格更新
    def update_player(self, p):
        """依輸入與狀態機更新單一角色一格。"""
        g = GEARS[p.gear]
        p.vcd = max(0.0, p.vcd - DT)
        p.inv = max(0.0, p.inv - DT)
        p.t += DT
        p.moving = False
        frozen = self.phase != "play"
        pr = (lambda k: False) if frozen else (lambda k: p.latch[k])
        held = (lambda k: False) if frozen else (lambda k: p.inp[k])

        if p.state == "dead":
            if p.t >= p.dur:
                p.spawn()
            return
        if p.state == "falling":
            if p.t >= p.dur:
                self.do_ko(p)
            return

        # 垂直方向（跳躍/擊飛）
        landed = False
        gz = ground_z(p.x, p.y)
        if p.z > gz or p.vz > 0:  # 在空中，或從柱子邊走下去
            p.vz -= GRAV * DT
            p.z += p.vz * DT
            if p.z <= gz:
                p.z, p.vz, landed = gz, 0.0, True
        # 擊退滑行
        if p.kvx or p.kvy:
            self.move(p, p.kvx * DT, p.kvy * DT)
            f = math.exp(-(6.5 if grounded(p) else 1.5) * DT)
            p.kvx *= f
            p.kvy *= f
            if abs(p.kvx) + abs(p.kvy) < 8:
                p.kvx = p.kvy = 0.0

        mx = (1 if held("r") else 0) - (1 if held("l") else 0)
        my = (1 if held("d") else 0) - (1 if held("u") else 0)
        st = p.state

        # Z 瞄準：鎖定最近的敵人，移動時面向不變（可以側移、後退）
        p.aim = None
        if held("z") and st in ("idle", "guard", "attack", "heavy", "recover"):
            tgt = self.aim_target(p)
            if tgt:
                p.aim = tgt.id
                if st in ("idle", "guard"):
                    dx, dy = tgt.x - p.x, tgt.y - p.y
                    d = math.hypot(dx, dy) or 1
                    p.fx, p.fy = dx / d, dy / d

        if st == "idle":
            if pr("x"):
                p.pend_x = True
            if pr("c"):
                p.pend_c = True
            all3 = held("z") and held("x") and held("c")
            if all3 and (pr("z") or p.pend_x or p.pend_c):
                p.pend_x = p.pend_c = False
                p.chord_t = 0.0
                if p.vcd <= 0 and p.holding is None:
                    self.start_special(p)
            elif held("x") and held("c") and grounded(p) and p.holding is None:
                p.pend_x = p.pend_c = False
                p.chord_t = 0.0
                self.set_state(p, "guard")
            elif p.pend_x or p.pend_c:
                p.chord_t += DT
                if p.chord_t >= CHORD_WAIT:
                    px = p.pend_x
                    p.pend_x = p.pend_c = False
                    p.chord_t = 0.0
                    if px:
                        self.light(p)
                    else:
                        self.heavy(p)
            if p.state == "idle" and pr("v") and grounded(p):
                p.vz = JUMP_V
                self.event("jump", x=round(p.x), y=round(p.y))
            if p.state == "idle" and (mx or my):
                n = math.hypot(mx, my)
                if p.aim is None:
                    p.fx, p.fy = mx / n, my / n
                sp = SPEED * (0.75 if p.holding is not None else 1.0) * (0.8 if p.aim else 1.0)
                self.move(p, mx / n * sp * DT, my / n * sp * DT)
                p.moving = True

        elif st == "charge":  # 巨劍按住 C 蓄力，放開或蓄滿就出招
            if not held("c") or p.t >= p.dur:
                p.charge_k = min(1.0, p.t / CHARGE_MAX)
                self.set_state(p, "heavy", HEAVY[2] / g["zspeed"])
                p.hitset = set()

        elif st == "heavy":
            a0, a1, _dur, kb, launch, stun = HEAVY
            sp = g["zspeed"]
            a0, a1 = a0 / sp, a1 / sp
            if p.gear == "axe":  # 戰斧：重攻擊改成丟出短程飛斧
                if p.t - DT < a0 <= p.t:
                    self.spawn_proj(p, "axe", 700, dmg=g["cdmg"], kb=460, launch=160, stun=0.5, out=0.24)
            elif a0 <= p.t <= a1:
                k = p.charge_k  # 巨劍蓄力倍率 0~1
                self.move(p, p.fx * 160 * DT, p.fy * 160 * DT)
                self.melee(p, g["crange"] * (1 + 0.25 * k), 0.2, round(g["cdmg"] * (1 + k)),
                           kb * (1 + 0.4 * k), launch, stun)
            if p.t >= p.dur:
                p.charge_k = 0.0
                self.set_state(p, "idle")

        elif st == "attack":
            combo = g.get("combo", COMBO)
            a0, a1, _dur, kb, launch, stun = combo[p.combo]
            sp = g["zspeed"]
            a0, a1 = a0 / sp, a1 / sp
            # 冰霜魔杖的普攻、雷光砲第三段是發射飛行物，不是近戰
            ranged = p.gear == "wand" or (p.gear == "blaster" and p.combo == 2)
            if p.t < a1 and not ranged:
                self.move(p, p.fx * 80 * DT, p.fy * 80 * DT)
            if ranged:
                if p.t - DT < a0 <= p.t:
                    self.fire_light(p, kb, launch, stun)
            elif a0 <= p.t <= a1:
                self.melee(p, g["zrange"], 0.25, g["zdmg"][p.combo], kb, launch, stun)
            if pr("x") and p.combo < len(combo) - 1 and p.t > a0 * 0.5:
                p.queued = True
            if p.t >= p.dur:
                if p.queued:
                    self.start_attack(p, p.combo + 1)
                else:
                    self.set_state(p, "idle")

        elif st == "guard":
            if pr("z") and p.vcd <= 0:  # 防禦中再按 Z = Z+X+C 大絕
                self.start_special(p)
            elif not (held("x") and held("c")):
                self.set_state(p, "idle")
            elif (mx or my) and p.aim is None:  # 防禦中可轉向但不能移動
                n = math.hypot(mx, my)
                p.fx, p.fy = mx / n, my / n

        elif st == "dash":
            self.move(p, p.fx * 780 * DT, p.fy * 780 * DT)
            self.melee(p, 42, 0.0, 16, 620, 280, 0.6, guard_break=True)
            if p.t >= p.dur:
                self.set_state(p, "recover", 0.25)

        elif st == "spin":
            if mx or my:
                n = math.hypot(mx, my)
                self.move(p, mx / n * 110 * DT, my / n * 110 * DT)
            if 0.08 <= p.t <= 0.45:
                self.melee(p, 92, -1.0, 12, 520, 200, 0.5, radial=True)
            if p.t >= p.dur:
                self.set_state(p, "recover", 0.2)

        elif st == "airatk":
            self.melee(p, 36, 0.0, 9, 400, 0, 0.4)
            if landed or grounded(p):
                self.set_state(p, "recover", 0.22)

        elif st == "leap":  # 巨劍破山斬：落地時衝擊波
            if landed or (grounded(p) and p.t > 0.1):
                p.kvx = p.kvy = 0.0
                self.melee(p, LEAP_RADIUS, -1.0, 18, 560, 260, 0.6, radial=True)
                self.event("quake", x=round(p.x), y=round(p.y))
                self.set_state(p, "recover", 0.3)

        elif st == "stab":  # 影襲背刺
            if 0.06 <= p.t <= 0.16:
                self.melee(p, 46, 0.2, 14, 220, 0, 0.75, guard_break=True)
            if p.t >= p.dur:
                self.set_state(p, "idle")

        elif st == "nova":  # 冰霜新星：詠唱 0.22 秒後爆開
            if p.t >= 0.22 and not p.nova_done:
                p.nova_done = True
                self.event("nova", x=round(p.x), y=round(p.y))
                for q in list(self.players.values()):
                    if q is not p and q.alive and math.hypot(q.x - p.x, q.y - p.y) <= NOVA_RADIUS + R and abs(q.z - p.z) < 60:
                        self.freeze(p, q)
            if p.t >= p.dur:
                self.set_state(p, "idle")

        elif st in ("hitstun", "guardbreak", "recover", "frozen"):
            if p.t >= p.dur:
                self.set_state(p, "idle")

        elif st == "down":
            if p.t >= p.dur and grounded(p):
                if p.ko_pending:
                    self.do_ko(p)
                    return
                self.set_state(p, "idle")
                p.inv = 0.6

        # 落地時不在平台上 → 掉落
        if grounded(p) and not on_platform(p.x, p.y) and p.alive:
            self.drop_crate(p)
            self.set_state(p, "falling", 0.8)
            self.event("fall", x=round(p.x), y=round(p.y))

    def light(self, p):
        """X 輕攻擊：拿著木箱就丟、空中是下踢、靠近木箱就撿、否則三段普攻第一段。"""
        if p.holding is not None:
            self.throw_crate(p)
            self.set_state(p, "recover", 0.18)
        elif not grounded(p):
            self.air_attack(p)
        else:
            c = self.near_crate(p)
            if c:
                c.state, c.owner = "held", p.id
                p.holding = c.id
                self.set_state(p, "recover", 0.15)
            else:
                self.start_attack(p, 0)

    def heavy(self, p):
        """C 重攻擊：出手慢但會擊倒；拿著木箱時一樣是丟出。"""
        if p.holding is not None:
            self.throw_crate(p)
            self.set_state(p, "recover", 0.18)
        elif not grounded(p):
            self.air_attack(p)
        elif p.gear == "greatsword":  # 巨劍：先進入蓄力，放開 C 才出招
            self.set_state(p, "charge", CHARGE_MAX)
        else:
            p.charge_k = 0.0
            self.set_state(p, "heavy", HEAVY[2] / GEARS[p.gear]["zspeed"])
            p.hitset = set()

    def fire_light(self, p, kb, launch, stun):
        """遠程普攻：冰霜魔杖發射冰彈；雷光砲第三段噴出五顆近距離散彈。"""
        g = GEARS[p.gear]
        if p.gear == "wand":
            big = p.combo == 2
            self.spawn_proj(p, "ice", 560, dmg=g["zdmg"][p.combo], kb=kb if big else 120, launch=launch,
                            stun=stun, life=0.55, rad=14 if big else 9)
        else:
            for a in (-0.42, -0.21, 0.0, 0.21, 0.42):
                self.spawn_proj(p, "pellet", 760, angle=a, dmg=4, kb=220, stun=0.35, life=0.17, rad=7)
            self.event("shot", id=p.id, x=round(p.x + p.fx * 30), y=round(p.y + p.fy * 30))

    def air_attack(self, p):
        """空中攻擊：往前下方踢。"""
        self.set_state(p, "airatk", 2.0)
        p.hitset = set()
        p.kvx, p.kvy = p.fx * 260, p.fy * 260
        p.vz = min(p.vz, -120)

    def aim_target(self, p):
        """找 Z 瞄準要鎖定的對象：距離 520 內最近的敵人。"""
        best, best_d = None, 520.0
        for q in self.players.values():
            if q is p or not q.alive:
                continue
            d = math.hypot(q.x - p.x, q.y - p.y)
            if d < best_d:
                best, best_d = q, d
        return best

    def near_crate(self, p):
        """找角色附近可撿的木箱。"""
        for c in self.crates:
            if c.state == "ground" and math.hypot(c.x - p.x, c.y - p.y) < R + 30:
                return c
        return None

    def throw_crate(self, p):
        """把手上的木箱朝面向丟出去。"""
        c = self.crates[p.holding]
        p.holding = None
        c.state, c.owner, c.t = "fly", p.id, 0.0
        c.x, c.y, c.z = p.x + p.fx * 26, p.y + p.fy * 26, p.z + 40
        c.vx, c.vy = p.fx * 680, p.fy * 680

    def update_crates(self):
        """更新木箱：跟著持有者、飛行命中、落地或重生。"""
        for c in self.crates:
            if c.state == "held":
                h = self.players.get(c.owner)
                if not h or h.holding != c.id:
                    c.state, c.owner = "ground", None
                    continue
                c.x, c.y, c.z = h.x, h.y, h.z + 46
            elif c.state == "fly":
                c.t += DT
                c.x += c.vx * DT
                c.y += c.vy * DT
                c.z = max(0.0, c.z - 30 * DT)
                if hits_pillar(c.x, c.y, 16, c.z) or not (0 <= c.x <= MAP["w"] and 0 <= c.y <= MAP["h"]):
                    self.break_crate(c)
                    continue
                thrower = self.players.get(c.owner)
                for q in self.players.values():
                    if q.id == c.owner or not q.alive or q.z > 70:
                        continue
                    d = math.hypot(q.x - c.x, q.y - c.y)
                    if d < R + 18:
                        n = math.hypot(c.vx, c.vy) or 1
                        self.hit(thrower, q, 14, c.vx / n, c.vy / n, 460, 160, 0.5)
                        self.break_crate(c)
                        break
                if c.state == "fly" and c.t > 0.75:
                    if on_platform(c.x, c.y):
                        c.state, c.z, c.owner = "ground", ground_z(c.x, c.y), None
                    else:
                        c.state, c.t = "gone", 0.0
            elif c.state == "gone":
                c.t += DT
                if c.t > 6:
                    c.reset()
                    self.event("crate", x=round(c.x), y=round(c.y))

    def break_crate(self, c):
        """木箱撞到東西碎掉，之後原地重生。"""
        self.event("break", x=round(c.x), y=round(c.y), z=round(c.z))
        c.state, c.t, c.owner = "gone", 0.0, None

    def spawn_proj(self, p, kind, speed, angle=0.0, **kw):
        """從角色前方射出飛行物；angle 為相對面向的偏轉（弧度）。kw 可覆寫傷害、擊退、壽命等。"""
        ca, sa = math.cos(angle), math.sin(angle)
        dx, dy = p.fx * ca - p.fy * sa, p.fx * sa + p.fy * ca
        b = {"id": self.new_id(), "kind": kind, "x": p.x + dx * 28, "y": p.y + dy * 28, "z": p.z + 22,
             "vx": dx * speed, "vy": dy * speed, "owner": p.id, "t": 0.0,
             "dmg": 10, "kb": 300, "launch": 0, "stun": 0.45, "life": 1.2, "rad": 10}
        b.update(kw)
        if kind == "axe":
            b.setdefault("out", AXE_OUT)
            b["back"], b["hits"] = False, set()
        self.projs.append(b)
        return b

    def update_projs(self):
        """更新所有飛行物：能量彈、冰彈、散彈、飛斧。"""
        keep = []
        for b in self.projs:
            b["t"] += DT
            if b["kind"] == "axe":
                if self.update_axe(b):
                    keep.append(b)
                continue
            b["x"] += b["vx"] * DT
            b["y"] += b["vy"] * DT
            if b["t"] > b["life"] or hits_pillar(b["x"], b["y"], b["rad"], b["z"]) or not (0 <= b["x"] <= MAP["w"] and 0 <= b["y"] <= MAP["h"]):
                if b["kind"] != "pellet":
                    self.event("pop", x=round(b["x"]), y=round(b["y"]), z=round(b["z"]), c=b["kind"])
                continue
            owner = self.players.get(b["owner"])
            hit = False
            for q in self.players.values():
                if q.id == b["owner"] or not q.alive or abs(q.z + 18 - b["z"]) > 50:
                    continue
                if math.hypot(q.x - b["x"], q.y - b["y"]) < R + b["rad"]:
                    n = math.hypot(b["vx"], b["vy"]) or 1
                    if self.hit(owner, q, b["dmg"], b["vx"] / n, b["vy"] / n, b["kb"], b["launch"], b["stun"]):
                        hit = True
                        break
            if hit:
                self.event("zap", x=round(b["x"]), y=round(b["y"]), z=round(b["z"]), c=b["kind"])
            else:
                keep.append(b)
        self.projs = keep

    def update_axe(self, b):
        """迴旋飛斧：去程直線飛，撞牆或時間到折返追回主人；去程、回程各可打中同一人一次。回傳是否保留。"""
        owner = self.players.get(b["owner"])
        if not b["back"]:
            b["x"] += b["vx"] * DT
            b["y"] += b["vy"] * DT
            if b["t"] >= b["out"] or hits_pillar(b["x"], b["y"], 12, b["z"]) or not (0 <= b["x"] <= MAP["w"] and 0 <= b["y"] <= MAP["h"]):
                b["back"] = True
        else:
            if not owner or not owner.alive:
                self.event("pop", x=round(b["x"]), y=round(b["y"]), z=round(b["z"]))
                return False
            dx, dy = owner.x - b["x"], owner.y - b["y"]
            d = math.hypot(dx, dy) or 1
            if d < 30 or b["t"] > 3:
                return False  # 接回手上
            b["vx"], b["vy"] = dx / d * 720, dy / d * 720
            b["x"] += b["vx"] * DT
            b["y"] += b["vy"] * DT
        leg = "b" if b["back"] else "o"
        for q in self.players.values():
            if q.id == b["owner"] or not q.alive or abs(q.z + 18 - b["z"]) > 55 or (leg, q.id) in b["hits"]:
                continue
            if math.hypot(q.x - b["x"], q.y - b["y"]) < R + 16:
                b["hits"].add((leg, q.id))
                n = math.hypot(b["vx"], b["vy"]) or 1
                if self.hit(owner, q, b["dmg"], b["vx"] / n, b["vy"] / n, b["kb"], b["launch"], b["stun"]):
                    self.event("zap", x=round(b["x"]), y=round(b["y"]), z=round(b["z"]))
        return True

    def bot_think(self, b):
        """電腦玩家的簡易 AI：追最近的人、靠近就打、偶爾防禦與放特技。"""
        inp = dict.fromkeys(KEYS, False)
        latch = dict.fromkeys(KEYS, False)
        b.inp, b.latch = inp, latch
        if not b.alive:
            return
        targets = [q for q in self.players.values() if q is not b and q.alive]
        if not targets:
            return
        t = min(targets, key=lambda q: math.hypot(q.x - b.x, q.y - b.y))
        dx, dy = t.x - b.x, t.y - b.y
        d = math.hypot(dx, dy) or 1
        pl = MAP["platform"]
        m = 70
        safe = pl["x"] + m < b.x < pl["x"] + pl["w"] - m and pl["y"] + m < b.y < pl["y"] + pl["h"] - m
        if not safe:  # 太靠邊緣就往中間走
            dx = pl["x"] + pl["w"] / 2 - b.x
            dy = pl["y"] + pl["h"] / 2 - b.y
            d = math.hypot(dx, dy) or 1
        if b.ai["guard"] > 0:
            b.ai["guard"] -= DT
            inp["x"] = inp["c"] = True
            return
        threat = t.state in ("attack", "dash", "spin") and d < 110
        if threat and random.random() < 0.06:
            b.ai["guard"] = 0.4
            return
        if d > 52 or not safe:
            inp["r"] = dx > d * 0.38
            inp["l"] = dx < -d * 0.38
            inp["d"] = dy > d * 0.38
            inp["u"] = dy < -d * 0.38
        elif b.state == "idle":
            b.fx, b.fy = dx / d, dy / d
        reach = GEARS[b.gear]["reach"]
        busy = b.pend_x or b.pend_c
        if b.vcd <= 0 and d < reach and safe and not busy and random.random() < 0.03:
            inp["z"] = inp["x"] = inp["c"] = True  # Z+X+C 大絕（Z 會自動瞄準）
            latch["z"] = True
        elif d < 70 and not busy and random.random() < 0.18:
            latch["c" if random.random() < 0.2 else "x"] = True
        elif random.random() < 0.004:
            latch["v"] = True

    def step(self):
        """推進整個世界一格（1/60 秒）。"""
        self.now += DT
        if self.phase == "play":
            if self.players:
                self.time_left -= DT
            if self.time_left <= 0:
                self.phase = "result"
                self.result_t = RESULT_SECONDS
                self.event("end")
        else:
            self.result_t -= DT
            if self.result_t <= 0:
                self.reset_match()
        for p in list(self.players.values()):
            if p.bot:
                self.bot_think(p)
        for p in list(self.players.values()):
            self.update_player(p)
        self.separate()
        self.update_crates()
        self.update_projs()
        for p in self.players.values():
            if not p.bot:
                p.latch = dict.fromkeys(KEYS, False)

    def reset_match(self):
        """新的一局：清分數、所有人重生、木箱歸位。"""
        self.phase = "play"
        self.time_left = MATCH_SECONDS
        self.projs = []
        for c in self.crates:
            c.reset()
        for p in self.players.values():
            p.kos = p.deaths = 0
            p.spawn()
        self.event("start")

    def snapshot(self):
        """整理要廣播給所有人的畫面資料。"""
        ps = []
        for p in self.players.values():
            ps.append({
                "id": p.id, "n": p.name, "c": p.color, "g": p.gear,
                "x": round(p.x, 1), "y": round(p.y, 1), "z": round(p.z, 1),
                "fx": round(p.fx, 2), "fy": round(p.fy, 2),
                "hp": p.hp, "s": p.state, "t": round(p.t, 3), "du": round(p.dur, 3),
                "cb": p.combo, "h": 1 if p.holding is not None else 0,
                "cd": round(p.vcd / GEARS[p.gear]["vcd"], 2), "k": p.kos, "de": p.deaths,
                "iv": 1 if p.inv > 0 else 0, "mv": 1 if p.moving else 0, "b": 1 if p.bot else 0,
                "am": p.aim or 0, "ch": p.ch, "ck": round(p.charge_k, 2),
            })
        cs = [{"id": c.id, "x": round(c.x, 1), "y": round(c.y, 1), "z": round(c.z, 1), "s": c.state}
              for c in self.crates if c.state != "gone"]
        bs = [{"id": b["id"], "k": b.get("kind", "bolt"), "x": round(b["x"], 1), "y": round(b["y"], 1),
               "z": round(b["z"], 1), "vx": round(b["vx"]), "vy": round(b["vy"])} for b in self.projs]
        msg = {"t": "s", "ph": self.phase, "tl": max(0, round(self.time_left)),
               "rt": max(0, round(self.result_t)), "p": ps, "cr": cs, "pj": bs, "fx": self.fx}
        self.fx = []
        return msg


game = None
game = Game()
clients = {}  # Conn -> player id


# ------------------------------------------------------------------ 輸入處理
def sanitize_name(name):
    """整理玩家名稱：去空白、限制長度。"""
    name = str(name or "").strip()[:12]
    return name or f"玩家{random.randint(100, 999)}"


def sanitize_color(color):
    """只接受 #rrggbb 格式的顏色。"""
    color = str(color or "")
    if len(color) == 7 and color[0] == "#" and all(ch in "0123456789abcdefABCDEF" for ch in color[1:]):
        return color
    return "#ff7a3d"


def sanitize_char(ch):
    """角色代號只接受英數、底線、減號，最多 24 字。"""
    ch = str(ch or "")[:24]
    return ch if all(c.isascii() and (c.isalnum() or c in "_-") for c in ch) else ""


def handle_message(conn, raw):
    """處理前端送來的一則訊息（加入、輸入、換裝、加減電腦）。"""
    try:
        msg = json.loads(raw)
    except ValueError:
        return
    kind = msg.get("t")
    pid = clients.get(conn)
    if kind == "join":
        gear = msg.get("gear") if msg.get("gear") in GEARS else "flame"
        if pid and pid in game.players:
            p = game.players[pid]
            p.name, p.color = sanitize_name(msg.get("name")), sanitize_color(msg.get("color"))
            if p.gear != gear:
                p.gear = gear
                p.vcd = GEARS[gear]["vcd"]
        else:
            pid = game.new_id()
            game.players[pid] = Player(pid, sanitize_name(msg.get("name")), sanitize_color(msg.get("color")), gear)
            clients[conn] = pid
            game.event("join", name=game.players[pid].name)
        game.players[pid].ch = sanitize_char(msg.get("ch"))
        conn.send(json.dumps({"t": "welcome", "id": pid, "map": MAP}))
    elif kind == "input" and pid in game.players:
        p = game.players[pid]
        keys = msg.get("k") or {}
        for k in KEYS:
            v = bool(keys.get(k))
            if v and not p.inp[k]:
                p.latch[k] = True
            p.inp[k] = v
    elif kind == "bot":
        bots = [p for p in game.players.values() if p.bot]
        if msg.get("add") and len(bots) < MAX_BOTS:
            bid = game.new_id()
            names = ["鐵罐", "飯糰", "阿砲", "小旋風", "豆腐", "黑輪"]
            colors = ["#8a8f98", "#c9a227", "#5aa36b", "#a05fd1", "#d9534f", "#3aa0c9"]
            i = len(bots) % len(names)
            game.players[bid] = Player(bid, "電腦·" + names[i], colors[i], random.choice(list(GEARS)), bot=True)
            game.event("join", name=game.players[bid].name)
        elif not msg.get("add") and bots:
            b = bots[-1]
            game.drop_crate(b)
            del game.players[b.id]
    elif kind == "ping":
        conn.send(json.dumps({"t": "pong", "ts": msg.get("ts")}))


def handle_close(conn):
    """玩家斷線：移除角色。"""
    pid = clients.pop(conn, None)
    p = game.players.pop(pid, None) if pid else None
    if p:
        game.drop_crate(p)
        game.event("leave", name=p.name)
    if not any(not q.bot for q in game.players.values()):  # 沒真人就清掉電腦
        game.players.clear()


# ------------------------------------------------------------------ WebSocket（手寫，免安裝套件）
class Conn:
    """單一 WebSocket 連線的收送封裝。"""

    def __init__(self, reader, writer):
        """保存 asyncio 的讀寫串流。"""
        self.reader = reader
        self.writer = writer
        self.open = True

    def _frame(self, op, payload):
        """組出伺服器端（不加遮罩）的 WebSocket frame。"""
        n = len(payload)
        if n < 126:
            head = struct.pack("!BB", 0x80 | op, n)
        elif n < 65536:
            head = struct.pack("!BBH", 0x80 | op, 126, n)
        else:
            head = struct.pack("!BBQ", 0x80 | op, 127, n)
        return head + payload

    def send(self, text):
        """送出文字訊息；對方塞車時直接丟掉這一包，避免記憶體暴增。"""
        if not self.open or self.writer.is_closing():
            return
        if self.writer.transport.get_write_buffer_size() > 512 * 1024:
            return
        self.writer.write(self._frame(1, text.encode("utf-8")))

    async def recv(self):
        """讀取一則完整訊息；連線關閉時回傳 None。"""
        buf = b""
        while True:
            b0, b1 = await self.reader.readexactly(2)
            fin, op = b0 & 0x80, b0 & 0x0F
            masked, n = b1 & 0x80, b1 & 0x7F
            if n == 126:
                n = struct.unpack("!H", await self.reader.readexactly(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", await self.reader.readexactly(8))[0]
            if n > 1 << 20:
                return None
            mask = await self.reader.readexactly(4) if masked else None
            data = await self.reader.readexactly(n)
            if mask and n:
                key = (mask * (n // 4 + 1))[:n]
                data = (int.from_bytes(data, "big") ^ int.from_bytes(key, "big")).to_bytes(n, "big")
            if op == 8:
                return None
            if op == 9:
                self.writer.write(self._frame(0xA, data))
                continue
            if op == 0xA:
                continue
            buf += data
            if fin:
                return buf.decode("utf-8", "replace")


MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
        ".ico": "image/x-icon", ".json": "application/json", ".webp": "image/webp", ".jpg": "image/jpeg",
        ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".bin": "application/octet-stream"}


async def serve_static(writer, target):
    """回傳 public 資料夾內的靜態檔案。"""
    path = target.split("?", 1)[0]
    if path == "/":
        path = "/index.html"
    file = (PUBLIC / path.lstrip("/")).resolve()
    if PUBLIC not in file.parents or not file.is_file():
        body, status, ctype = b"not found", "404 Not Found", "text/plain"
    else:
        body, status, ctype = file.read_bytes(), "200 OK", MIME.get(file.suffix, "application/octet-stream")
    writer.write(
        f"HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\n"
        f"Cache-Control: no-cache\r\nConnection: close\r\n\r\n".encode() + body
    )
    await writer.drain()


async def handle_client(reader, writer):
    """每個 TCP 連線的進入點：分辨一般 HTTP 或 WebSocket 升級。"""
    conn = None
    try:
        head = await reader.readuntil(b"\r\n\r\n")
        lines = head.decode("latin-1").split("\r\n")
        parts = lines[0].split(" ")
        target = parts[1] if len(parts) > 1 else "/"
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        if headers.get("upgrade", "").lower() != "websocket":
            await serve_static(writer, target)
            return
        key = headers.get("sec-websocket-key", "")
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        writer.write(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n\r\n".encode()
        )
        await writer.drain()
        sock = writer.get_extra_info("socket")
        if sock is not None:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        conn = Conn(reader, writer)
        clients[conn] = None
        while True:
            # 前端每 0.25 秒會送一次按鍵狀態；30 秒都沒消息就當作斷線（避免殘留幽靈玩家）
            raw = await asyncio.wait_for(conn.recv(), timeout=30)
            if raw is None:
                break
            handle_message(conn, raw)
    except (asyncio.IncompleteReadError, ConnectionError, asyncio.LimitOverrunError, OSError, TimeoutError):
        pass
    finally:
        if conn:
            conn.open = False
            handle_close(conn)
        try:
            writer.close()
        except Exception:
            pass


async def game_loop():
    """固定 60 格/秒推進遊戲並每 1/30 秒廣播一次畫面。"""
    nxt = time.perf_counter()
    last_send = 0.0
    while True:
        now = time.perf_counter()
        steps = 0
        while now >= nxt and steps < 10:  # Windows 計時器解析度較粗，落後就補跑
            game.step()
            nxt += DT
            steps += 1
        if now - nxt > 1:  # 嚴重延遲就放棄追趕
            nxt = now
        if now - last_send >= SEND_INTERVAL and clients:
            last_send = now
            data = json.dumps(game.snapshot(), ensure_ascii=False, separators=(",", ":"))
            for c in list(clients):
                c.send(data)
        await asyncio.sleep(max(0.0, min(nxt - time.perf_counter(), 0.005)))


def lan_ips():
    """列出本機在區域網路上的 IP，方便告訴朋友連線網址。"""
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))  # 不會真的送封包，只是讓系統挑出對外網卡
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if not ip.startswith("127."):
                ips.add(ip)
    except OSError:
        pass
    return sorted(ips)


async def main():
    """啟動 HTTP/WebSocket 伺服器與遊戲迴圈。"""
    server = await asyncio.start_server(handle_client, HOST, PORT)
    print("=" * 52)
    print(" 配件大亂鬥 Gear Brawl 伺服器已啟動")
    print(f"  本機遊玩： http://localhost:{PORT}")
    for ip in lan_ips():
        print(f"  同網路朋友： http://{ip}:{PORT}")
    print(" 按 Ctrl+C 關閉")
    print("=" * 52, flush=True)
    asyncio.create_task(game_loop())
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
