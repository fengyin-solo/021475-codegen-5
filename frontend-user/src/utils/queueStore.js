/**
 * 现场排队叫号存储管理
 *
 * 功能说明：
 * - 管理每张球桌的现场排队队列（取号、叫号、到场、过号、取消、就坐、完成）
 * - 维护用户顺序（号序），过号恢复后回到队首可叫位置，取消/就坐后顺序自动前移
 * - localStorage 持久化，页面刷新、离开后返回球桌页时顺序与状态保持一致
 * - 网络中断时操作先在本地生效并入队发件箱，恢复后自动同步
 *
 * 状态流转：
 *   waiting（排队中）→ called（已叫号）→ arrived（已到场）→ seated（就坐中）→ completed（已完成）
 *                          └→ missed（已过号）→ restore → waiting（回到队首，恢复原顺序优先级）
 *   任意未终结状态 → cancelled（已取消）
 */

import { reactive, computed } from 'vue'
import { api } from './api'

// ==================== 常量定义 ====================

const STORAGE_KEY = 'billiard_queue_v1'
const SEEDED_KEY = 'billiard_queue_seeded'

/** 排队状态 */
export const QUEUE_STATUS = {
  WAITING: 'waiting',
  CALLED: 'called',
  ARRIVED: 'arrived',
  SEATED: 'seated',
  MISSED: 'missed',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed'
}

/** 参与排队计数（会占用排队名额）的状态 */
export const ACTIVE_STATUSES = [
  QUEUE_STATUS.WAITING,
  QUEUE_STATUS.CALLED,
  QUEUE_STATUS.ARRIVED,
  QUEUE_STATUS.SEATED
]

/** 状态展示配置 */
export const QUEUE_STATUS_CONFIG = {
  waiting: { text: '排队中', type: 'info' },
  called: { text: '已叫号', type: 'warning' },
  arrived: { text: '已到场', type: 'success' },
  seated: { text: '使用中', type: 'primary' },
  missed: { text: '已过号', type: 'danger' },
  cancelled: { text: '已取消', type: 'default' },
  completed: { text: '已完成', type: 'default' }
}

/** 每桌最大排队人数（含等待、已叫号、到场、使用中） */
export const MAX_QUEUE_PER_TABLE = 10

/** 叫号后默认等待时长（毫秒），超时未到场自动过号 */
const DEFAULT_CALLED_GRACE_MS = 60 * 1000

/** 模拟就坐使用时长（毫秒），到时自动完成并释放球桌 */
const DEFAULT_SEAT_HOLD_MS = 120 * 1000

/** 每人预计等待时长（分钟），用于预计等待时间展示 */
const WAIT_MINUTES_PER_PERSON = 15

/** 演示用户标识 */
const SELF_USER_ID = 'me'

// ==================== 响应式状态 ====================

export const queueState = reactive({
  /** 票号集合：{ [ticketId]: ticket } */
  tickets: {},
  /** 每桌自增序号：{ [tableId]: number } */
  counters: {},
  /** 过号恢复的自增顺序号，值越小恢复越早、越靠队首 */
  restoredCounter: 0,
  /** 断网期间待同步操作发件箱 */
  outbox: [],
  /** 当前是否在线（真实网络/模拟网络） */
  online: true
})

// ==================== 存储 ====================

function loadState() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return
    const data = JSON.parse(stored)
    if (data && typeof data === 'object') {
      queueState.tickets = data.tickets || {}
      queueState.counters = data.counters || {}
      queueState.restoredCounter = data.restoredCounter || 0
      queueState.outbox = Array.isArray(data.outbox) ? data.outbox : []
    }
  } catch (e) {
    console.error('[queueStore] 加载排队数据失败', e)
  }
}

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tickets: queueState.tickets,
        counters: queueState.counters,
        restoredCounter: queueState.restoredCounter,
        outbox: queueState.outbox
      })
    )
    return true
  } catch (e) {
    console.error('[queueStore] 保存排队数据失败', e)
    return false
  }
}

// ==================== 工具函数 ====================

/** 生成排队号，例如 2 号桌第 3 位 -> A003 */
function formatTicketNo(tableId, seq) {
  const letter = String.fromCharCode(64 + (Number(tableId) || 1))
  return `${letter}${String(seq).padStart(3, '0')}`
}

function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(status)
}

/**
 * 等待队列排序：已叫号/到场的票在前（按叫号时间），
 * 过号恢复的票按恢复顺序紧随其后，普通等待票按原始取号顺序
 */
function waitingOrderCompare(a, b) {
  const aRestored = a.status === QUEUE_STATUS.WAITING && !!a.restoredAt
  const bRestored = b.status === QUEUE_STATUS.WAITING && !!b.restoredAt
  if (aRestored && bRestored) return a.restoreSeq - b.restoreSeq
  if (aRestored) return -1
  if (bRestored) return 1
  return a.seq - b.seq
}

/** 当前位于队首、等待叫号的票 */
function getHeadTicket(tableId) {
  return Object.values(queueState.tickets)
    .filter(t => t.tableId === tableId && t.status === QUEUE_STATUS.WAITING)
    .sort(waitingOrderCompare)[0] || null
}

/**
 * 票在活跃队列中的位置（1 起）。
 * 已叫号/已到场固定为第 1 位；等待中按等待队列排序 + 前面已叫号人数计算。
 */
function computePosition(ticket) {
  if (!ticket || !isActiveStatus(ticket.status)) return null
  if (ticket.status === QUEUE_STATUS.CALLED || ticket.status === QUEUE_STATUS.ARRIVED) {
    return 1
  }
  if (ticket.status === QUEUE_STATUS.SEATED) return 0

  const waiting = Object.values(queueState.tickets)
    .filter(t => t.tableId === ticket.tableId && t.status === QUEUE_STATUS.WAITING)
    .sort(waitingOrderCompare)
  const index = waiting.findIndex(t => t.id === ticket.id)
  if (index === -1) return null
  const calledAhead = Object.values(queueState.tickets).filter(
    t =>
      t.tableId === ticket.tableId &&
      (t.status === QUEUE_STATUS.CALLED || t.status === QUEUE_STATUS.ARRIVED)
  ).length
  return index + 1 + calledAhead
}

// ==================== 远程同步 ====================

/**
 * 默认远程操作：走统一 API 层（mock 模式返回成功，真实模式请求后端）。
 * 测试中可通过 queueStore.setRemote 替换。
 */
let remoteOp = async (op, payload) => {
  const result = await api.queueAction(op, payload)
  if (!result.success) throw new Error(result.error || '排队服务同步失败')
  return result.data
}

/**
 * 将一次操作同步到服务端：在线立即同步；断网时进入发件箱，
 * 本地状态已经先行生效，恢复后按顺序补同步。
 */
async function syncOp(op, payload) {
  if (!queueState.online) {
    queueState.outbox.push({ op, payload, ts: Date.now() })
    persist()
    return { synced: false }
  }
  try {
    const data = await remoteOp(op, payload)
    return { synced: true, data }
  } catch (e) {
    // 同步失败按断网处理，进入发件箱稍后重试，本地顺序不变
    queueState.outbox.push({ op, payload, ts: Date.now() })
    persist()
    console.warn('[queueStore] 排队操作同步失败，已加入待同步队列', e.message)
    return { synced: false, error: e.message }
  }
}

/**
 * 重放发件箱。按入箱顺序逐条同步，失败则中断保留剩余操作，
 * 保证顺序变更不会丢失或错乱。
 */
async function flushOutbox() {
  if (!queueState.online) return { flushed: 0, remaining: queueState.outbox.length }

  let flushed = 0
  const pending = [...queueState.outbox]
  queueState.outbox = []

  for (const item of pending) {
    try {
      await remoteOp(item.op, item.payload)
      flushed += 1
    } catch (e) {
      // 仍然失败：本条及后续全部保留，顺序不乱
      const failIndex = pending.findIndex(p => p === item)
      queueState.outbox = pending.slice(failIndex)
      persist()
      return { flushed, remaining: queueState.outbox.length, error: e.message }
    }
  }

  persist()
  return { flushed, remaining: 0 }
}

// ==================== 核心动作 ====================

function getTicketInternal(ticketId) {
  return queueState.tickets[ticketId] || null
}

function updateTicketInternal(ticketId, updates) {
  const ticket = queueState.tickets[ticketId]
  if (!ticket) return null
  Object.assign(ticket, updates)
  ticket.updatedAt = Date.now()
  persist()
  return ticket
}

/** 错误信息常量，便于页面与测试识别 */
export const QUEUE_ERRORS = {
  ALREADY_JOINED: '您已在该球桌排队，请勿重复取号',
  QUEUE_FULL: '该球桌排队已满，请稍后再试',
  TICKET_NOT_FOUND: '排队记录不存在',
  INVALID_TRANSITION: '当前排队状态不支持此操作'
}

let initialized = false

// ==================== 导出存储 ====================

export const queueStore = {
  QUEUE_STATUS,

  /** 初始化：恢复本地数据、监听浏览器网络事件（重复调用安全） */
  init() {
    loadState()
    if (initialized || typeof window === 'undefined') return
    initialized = true
    window.addEventListener('online', () => {
      queueState.online = true
      flushOutbox()
    })
    window.addEventListener('offline', () => {
      queueState.online = false
    })
    queueState.online = typeof navigator === 'undefined' || navigator.onLine !== false
  },

  /** 仅供测试：清空全部本地数据 */
  reset() {
    queueState.tickets = {}
    queueState.counters = {}
    queueState.restoredCounter = 0
    queueState.outbox = []
    queueState.online = true
    try {
      localStorage.removeItem(STORAGE_KEY)
      localStorage.removeItem(SEEDED_KEY)
    } catch (e) {
      /* ignore */
    }
  },

  /** 仅供测试：替换远程操作实现 */
  setRemote(fn) {
    remoteOp = typeof fn === 'function' ? fn : async () => ({})
  },

  /** 仅供测试：重置为默认远程实现（延迟由测试控制时不适用） */
  resetRemote() {
    remoteOp = async (op, payload) => {
      const result = await api.queueAction(op, payload)
      if (!result.success) throw new Error(result.error || '排队服务同步失败')
      return result.data
    }
  },

  /** 设置模拟网络状态，断网时停止远程同步 */
  async setOnline(online) {
    queueState.online = !!online
    if (online) {
      return flushOutbox()
    }
    persist()
    return { flushed: 0, remaining: queueState.outbox.length }
  },

  isOnline() {
    return queueState.online
  },

  get pendingSyncCount() {
    return queueState.outbox.length
  },

  // ---------- 查询 ----------

  getTicket(ticketId) {
    const ticket = getTicketInternal(ticketId)
    return ticket ? this.getTicketView(ticketId) : null
  },

  /**
   * 用户在某桌的活跃票（等待/叫号/到场/使用中），过号票单独通过 getMissedTicket 获取。
   * 重复排队校验依据此方法。
   */
  getMyTicket(tableId, userId = SELF_USER_ID) {
    const ticket = Object.values(queueState.tickets).find(
      t => t.tableId === tableId && t.userId === userId && isActiveStatus(t.status)
    )
    return ticket ? this.getTicketView(ticket.id) : null
  },

  /** 用户在某桌的过号票（可一键恢复顺序） */
  getMissedTicket(tableId, userId = SELF_USER_ID) {
    const ticket = Object.values(queueState.tickets).find(
      t => t.tableId === tableId && t.userId === userId && t.status === QUEUE_STATUS.MISSED
    )
    return ticket ? this.getTicketView(ticket.id) : null
  },

  /** 用户全部未终结的票（跨球桌），用于页面顶部"我的排队"汇总 */
  getMyActiveTickets(userId = SELF_USER_ID) {
    return Object.values(queueState.tickets)
      .filter(t => t.userId === userId && isActiveStatus(t.status))
      .map(t => this.getTicketView(t.id))
      .sort((a, b) => b.createdAt - a.createdAt)
  },

  /**
   * 球桌占用判定：存在"使用中"票即占用。
   * 一旦使用中票完成/取消，球桌立即恢复可用。
   */
  isTableBusy(tableId) {
    return Object.values(queueState.tickets).some(
      t => t.tableId === tableId && t.status === QUEUE_STATUS.SEATED
    )
  },

  /** 某桌排队人数（含等待、叫号、到场、使用中） */
  getQueueCount(tableId) {
    return Object.values(queueState.tickets).filter(
      t => t.tableId === tableId && isActiveStatus(t.status)
    ).length
  },

  isQueueFull(tableId) {
    return this.getQueueCount(tableId) >= MAX_QUEUE_PER_TABLE
  },

  /** 当前正在叫号（已叫号未到场）的票，用于大屏式叫号展示 */
  getCallingTicket(tableId) {
    const ticket = Object.values(queueState.tickets)
      .filter(t => t.tableId === tableId && t.status === QUEUE_STATUS.CALLED)
      .sort((a, b) => a.calledAt - b.calledAt)[0]
    return ticket ? this.getTicketView(ticket.id) : null
  },

  /**
   * 球桌排队视图：叫号信息、等待列表、使用中票、排队人数。
   * 顺序变更（取消/过号/到场/恢复）后列表与位置实时重算。
   */
  getTableView(tableId) {
    const all = Object.values(queueState.tickets).filter(t => t.tableId === tableId)
    const waiting = all
      .filter(t => t.status === QUEUE_STATUS.WAITING)
      .sort(waitingOrderCompare)
      .map(t => this.getTicketView(t.id))
    const called = all
      .filter(t => t.status === QUEUE_STATUS.CALLED)
      .sort((a, b) => a.calledAt - b.calledAt)
      .map(t => this.getTicketView(t.id))
    const arrived = all
      .filter(t => t.status === QUEUE_STATUS.ARRIVED)
      .map(t => this.getTicketView(t.id))
    const seated = all
      .filter(t => t.status === QUEUE_STATUS.SEATED)
      .map(t => this.getTicketView(t.id))
    const missed = all
      .filter(t => t.status === QUEUE_STATUS.MISSED)
      .map(t => this.getTicketView(t.id))

    // 活跃展示顺序：已叫号/到场在前，等待队列紧随其后，使用中单独展示
    const ahead = [...called, ...arrived]
    const queueList = [...ahead, ...waiting].map((t, i) => ({
      ...t,
      position: i + 1
    }))

    return {
      tableId,
      count: this.getQueueCount(tableId),
      full: this.isQueueFull(tableId),
      busy: this.isTableBusy(tableId),
      calling: called[0] || null,
      calledCount: called.length,
      arrived,
      waiting,
      seated,
      missed,
      queueList
    }
  },

  /** 票的完整视图：位置、预计等待、叫号倒计时、状态文案 */
  getTicketView(ticketId) {
    const ticket = getTicketInternal(ticketId)
    if (!ticket) return null

    const position = computePosition(ticket)
    const statusInfo = QUEUE_STATUS_CONFIG[ticket.status] || { text: ticket.status, type: 'info' }
    const now = Date.now()

    let estimatedWaitMinutes = null
    let calledRemainMs = null

    if (ticket.status === QUEUE_STATUS.WAITING && position !== null) {
      // 前方等待人数（不含正在叫号者，叫号后很快就会轮到自己）
      const waitingAhead = Object.values(queueState.tickets).filter(
        t => t.tableId === ticket.tableId && t.status === QUEUE_STATUS.WAITING
      )
        .sort(waitingOrderCompare)
        .findIndex(t => t.id === ticket.id)
      const waitPersons = Math.max(0, waitingAhead)
      estimatedWaitMinutes = waitPersons * WAIT_MINUTES_PER_PERSON
    } else if (ticket.status === QUEUE_STATUS.CALLED) {
      estimatedWaitMinutes = 0
      calledRemainMs = Math.max(0, (ticket.calledAt || now) + ticket.graceMs - now)
    } else if (ticket.status === QUEUE_STATUS.ARRIVED) {
      estimatedWaitMinutes = 0
    }

    return {
      ...ticket,
      position,
      statusText: statusInfo.text,
      statusType: statusInfo.type,
      estimatedWaitMinutes,
      calledRemainMs,
      isSelf: ticket.userId === SELF_USER_ID,
      pendingSync: !ticket.synced
    }
  },

  // ---------- 写操作 ----------

  /**
   * 现场取号排队
   * - 已有活跃票：拒绝重复排队
   * - 排队满员：拒绝
   * - 断网：本地立即取号生效，操作进入发件箱，恢复后补同步
   */
  async joinQueue(tableId, options = {}) {
    const userId = options.userId || SELF_USER_ID
    const userName = options.userName || '我'

    const existing = Object.values(queueState.tickets).find(
      t => t.tableId === tableId && t.userId === userId && isActiveStatus(t.status)
    )
    if (existing) {
      const error = new Error(QUEUE_ERRORS.ALREADY_JOINED)
      error.code = 'ALREADY_JOINED'
      error.ticketId = existing.id
      throw error
    }

    if (this.isQueueFull(tableId)) {
      const error = new Error(QUEUE_ERRORS.QUEUE_FULL)
      error.code = 'QUEUE_FULL'
      throw error
    }

    const seq = (queueState.counters[tableId] || 0) + 1
    queueState.counters[tableId] = seq

    const now = Date.now()
    const id = `QT_${tableId}_${seq}_${now.toString(36)}`
    const ticket = {
      id,
      ticketNo: formatTicketNo(tableId, seq),
      tableId,
      userId,
      userName,
      seq,
      status: QUEUE_STATUS.WAITING,
      graceMs: options.graceMs || DEFAULT_CALLED_GRACE_MS,
      seatHoldMs: options.seatHoldMs || DEFAULT_SEAT_HOLD_MS,
      restoredAt: null,
      restoreSeq: null,
      calledAt: null,
      arrivedAt: null,
      seatedAt: null,
      completedAt: null,
      cancelledAt: null,
      missedAt: null,
      synced: queueState.online,
      createdAt: now
    }
    queueState.tickets[id] = ticket
    persist()

    const result = await syncOp('join', {
      ticketId: id,
      ticketNo: ticket.ticketNo,
      tableId,
      userId,
      userName,
      seq
    })
    if (result.synced) {
      ticket.synced = true
      persist()
    }

    return this.getTicketView(id)
  },

  /** 叫号：队首张等待票进入已叫号 */
  async callNext(tableId, options = {}) {
    const head = options.ticketId
      ? getTicketInternal(options.ticketId)
      : getHeadTicket(tableId)
    if (!head || head.tableId !== tableId || head.status !== QUEUE_STATUS.WAITING) {
      return null
    }
    updateTicketInternal(head.id, {
      status: QUEUE_STATUS.CALLED,
      calledAt: Date.now()
    })
    await syncOp('call', { ticketId: head.id, tableId, ticketNo: head.ticketNo })
    return this.getTicketView(head.id)
  },

  /** 到场确认：已叫号 -> 已到场 */
  async markArrived(ticketId) {
    const ticket = getTicketInternal(ticketId)
    if (!ticket) {
      const error = new Error(QUEUE_ERRORS.TICKET_NOT_FOUND)
      error.code = 'TICKET_NOT_FOUND'
      throw error
    }
    if (ticket.status !== QUEUE_STATUS.CALLED) {
      const error = new Error(QUEUE_ERRORS.INVALID_TRANSITION)
      error.code = 'INVALID_TRANSITION'
      throw error
    }
    updateTicketInternal(ticketId, {
      status: QUEUE_STATUS.ARRIVED,
      arrivedAt: Date.now()
    })
    await syncOp('arrive', { ticketId, tableId: ticket.tableId, ticketNo: ticket.ticketNo })
    return this.getTicketView(ticketId)
  },

  /**
   * 过号：已叫号且超过等待时限（或手动）-> 已过号。
   * 过号后其位置让给后续排队者；可通过 restoreTicket 恢复。
   */
  async markMissed(ticketId, options = {}) {
    const ticket = getTicketInternal(ticketId)
    if (!ticket) {
      const error = new Error(QUEUE_ERRORS.TICKET_NOT_FOUND)
      error.code = 'TICKET_NOT_FOUND'
      throw error
    }
    if (ticket.status !== QUEUE_STATUS.CALLED) {
      const error = new Error(QUEUE_ERRORS.INVALID_TRANSITION)
      error.code = 'INVALID_TRANSITION'
      throw error
    }
    updateTicketInternal(ticketId, {
      status: QUEUE_STATUS.MISSED,
      missedAt: Date.now(),
      calledAt: ticket.calledAt || null,
      missReason: options.reason || 'timeout'
    })
    await syncOp('miss', { ticketId, tableId: ticket.tableId, ticketNo: ticket.ticketNo })
    return this.getTicketView(ticketId)
  },

  /**
   * 过号恢复：已过号 -> 排队中，并插到所有普通等待票之前（队首可叫位置）。
   * 多张恢复票之间按恢复先后排序，顺序可恢复且不插队到已叫号者之前。
   */
  async restoreTicket(ticketId) {
    const ticket = getTicketInternal(ticketId)
    if (!ticket) {
      const error = new Error(QUEUE_ERRORS.TICKET_NOT_FOUND)
      error.code = 'TICKET_NOT_FOUND'
      throw error
    }
    if (ticket.status !== QUEUE_STATUS.MISSED) {
      const error = new Error(QUEUE_ERRORS.INVALID_TRANSITION)
      error.code = 'INVALID_TRANSITION'
      throw error
    }
    queueState.restoredCounter += 1
    updateTicketInternal(ticketId, {
      status: QUEUE_STATUS.WAITING,
      restoredAt: Date.now(),
      restoreSeq: queueState.restoredCounter,
      missedAt: null,
      calledAt: null,
      missReason: null
    })
    persist()
    await syncOp('restore', { ticketId, tableId: ticket.tableId, ticketNo: ticket.ticketNo })
    return this.getTicketView(ticketId)
  },

  /** 就坐引导：已到场 -> 使用中（球桌转为占用） */
  async markSeated(ticketId) {
    const ticket = getTicketInternal(ticketId)
    if (!ticket) {
      const error = new Error(QUEUE_ERRORS.TICKET_NOT_FOUND)
      error.code = 'TICKET_NOT_FOUND'
      throw error
    }
    if (ticket.status !== QUEUE_STATUS.ARRIVED) {
      const error = new Error(QUEUE_ERRORS.INVALID_TRANSITION)
      error.code = 'INVALID_TRANSITION'
      throw error
    }
    updateTicketInternal(ticketId, {
      status: QUEUE_STATUS.SEATED,
      seatedAt: Date.now()
    })
    await syncOp('seat', { ticketId, tableId: ticket.tableId, ticketNo: ticket.ticketNo })
    return this.getTicketView(ticketId)
  },

  /** 完成使用：使用中 -> 已完成，球桌释放恢复可预约 */
  async completeTicket(ticketId) {
    const ticket = getTicketInternal(ticketId)
    if (!ticket) {
      const error = new Error(QUEUE_ERRORS.TICKET_NOT_FOUND)
      error.code = 'TICKET_NOT_FOUND'
      throw error
    }
    if (ticket.status !== QUEUE_STATUS.SEATED) {
      const error = new Error(QUEUE_ERRORS.INVALID_TRANSITION)
      error.code = 'INVALID_TRANSITION'
      throw error
    }
    updateTicketInternal(ticketId, {
      status: QUEUE_STATUS.COMPLETED,
      completedAt: Date.now()
    })
    await syncOp('complete', { ticketId, tableId: ticket.tableId, ticketNo: ticket.ticketNo })
    return this.getTicketView(ticketId)
  },

  /** 取消排队：等待/已叫号/已到场 -> 已取消，后续人员顺序前移 */
  async cancelTicket(ticketId) {
    const ticket = getTicketInternal(ticketId)
    if (!ticket) {
      const error = new Error(QUEUE_ERRORS.TICKET_NOT_FOUND)
      error.code = 'TICKET_NOT_FOUND'
      throw error
    }
    if (
      ticket.status !== QUEUE_STATUS.WAITING &&
      ticket.status !== QUEUE_STATUS.CALLED &&
      ticket.status !== QUEUE_STATUS.ARRIVED
    ) {
      const error = new Error(QUEUE_ERRORS.INVALID_TRANSITION)
      error.code = 'INVALID_TRANSITION'
      throw error
    }
    updateTicketInternal(ticketId, {
      status: QUEUE_STATUS.CANCELLED,
      cancelledAt: Date.now()
    })
    await syncOp('cancel', { ticketId, tableId: ticket.tableId, ticketNo: ticket.ticketNo })
    return this.getTicketView(ticketId)
  },

  /**
   * 演示/后台推进：模拟现场叫号流转
   * 1. 其他顾客叫号后一段时间自动到场
   * 2. 已叫号超过等待时限 -> 过号（当前用户需自行点击到场，超时同样过号，可恢复顺序）
   * 3. 已到场 -> 引导就坐（球桌转为占用）
   * 4. 使用中到时 -> 完成并释放球桌
   * 5. 队首等待 -> 自动叫号
   * 返回本轮发生的事件列表，页面可据此弹出叫号提醒。
   */
  advanceSimulation(now = Date.now()) {
    const events = []
    const tickets = Object.values(queueState.tickets)

    // 1. 其他顾客叫号后约 40% 等待时长内自动到场
    tickets
      .filter(t => t.status === QUEUE_STATUS.CALLED && t.userId !== SELF_USER_ID)
      .sort((a, b) => a.calledAt - b.calledAt)
      .forEach(t => {
        if (now - t.calledAt >= Math.round(t.graceMs * 0.4)) {
          updateTicketInternal(t.id, { status: QUEUE_STATUS.ARRIVED, arrivedAt: now })
          events.push({ type: 'arrived', ticketId: t.id, tableId: t.tableId, ticketNo: t.ticketNo })
        }
      })

    // 2. 叫号超时 -> 过号
    tickets
      .filter(t => t.status === QUEUE_STATUS.CALLED)
      .sort((a, b) => a.calledAt - b.calledAt)
      .forEach(t => {
        if (now - t.calledAt >= t.graceMs) {
          updateTicketInternal(t.id, {
            status: QUEUE_STATUS.MISSED,
            missedAt: now,
            missReason: 'timeout'
          })
          events.push({
            type: 'missed',
            ticketId: t.id,
            tableId: t.tableId,
            ticketNo: t.ticketNo,
            isSelf: t.userId === SELF_USER_ID
          })
        }
      })

    // 3. 已到场 -> 就坐
    tickets
      .filter(t => t.status === QUEUE_STATUS.ARRIVED)
      .forEach(t => {
        updateTicketInternal(t.id, { status: QUEUE_STATUS.SEATED, seatedAt: now })
        events.push({
          type: 'seated',
          ticketId: t.id,
          tableId: t.tableId,
          ticketNo: t.ticketNo,
          isSelf: t.userId === SELF_USER_ID
        })
      })

    // 4. 使用中到时 -> 完成释放
    tickets
      .filter(t => t.status === QUEUE_STATUS.SEATED)
      .forEach(t => {
        if (t.seatedAt && now - t.seatedAt >= t.seatHoldMs) {
          updateTicketInternal(t.id, { status: QUEUE_STATUS.COMPLETED, completedAt: now })
          events.push({ type: 'completed', ticketId: t.id, tableId: t.tableId, ticketNo: t.ticketNo })
        }
      })

    // 5. 队首叫号（本桌没有已叫号/已到场票时叫下一位）
    const tableIds = [...new Set(tickets.map(t => t.tableId))]
    tableIds.forEach(tableId => {
      const hasCalledAhead = tickets.some(
        t =>
          t.tableId === tableId &&
          (t.status === QUEUE_STATUS.CALLED || t.status === QUEUE_STATUS.ARRIVED)
      )
      if (hasCalledAhead) return
      const head = getHeadTicket(tableId)
      if (head) {
        updateTicketInternal(head.id, { status: QUEUE_STATUS.CALLED, calledAt: now })
        events.push({
          type: 'called',
          ticketId: head.id,
          tableId,
          ticketNo: head.ticketNo,
          isSelf: head.userId === SELF_USER_ID
        })
      }
    })

    return events
  },

  /**
   * 注入演示排队数据（仅首次，刷新/返回页面不重置真实顺序）。
   * @param {Array} tables 球桌列表
   * @param {Object} [options]
   * @param {number} [options.busyTableId] 预置一张"使用中"的占用桌
   * @param {number} [options.waitingTableId] 在该桌预置几位等待顾客
   */
  seedDemoData(tables, options = {}) {
    try {
      if (localStorage.getItem(SEEDED_KEY)) return false
    } catch (e) {
      /* ignore */
    }
    if (Object.keys(queueState.tickets).length > 0) return false

    const now = Date.now()
    const demoNames = ['王同学', '李女士', '陈先生', '赵同学', '周女士']
    let created = false

    const busyTable =
      tables.find(t => t.id === options.busyTableId) ||
      tables.find(t => !t.available) ||
      null
    if (busyTable) {
      queueState.counters[busyTable.id] = (queueState.counters[busyTable.id] || 0) + 1
      const seq = queueState.counters[busyTable.id]
      const id = `QT_seed_busy_${busyTable.id}`
      queueState.tickets[id] = {
        id,
        ticketNo: formatTicketNo(busyTable.id, seq),
        tableId: busyTable.id,
        userId: 'demo_seated',
        userName: '到店顾客',
        seq,
        status: QUEUE_STATUS.SEATED,
        graceMs: DEFAULT_CALLED_GRACE_MS,
        seatHoldMs: DEFAULT_SEAT_HOLD_MS,
        restoredAt: null,
        restoreSeq: null,
        calledAt: now - 30 * 1000,
        arrivedAt: now - 25 * 1000,
        seatedAt: now - 20 * 1000,
        completedAt: null,
        cancelledAt: null,
        missedAt: null,
        synced: true,
        createdAt: now - 60 * 1000
      }
      created = true
    }

    const waitingTable =
      tables.find(t => t.id === options.waitingTableId) ||
      tables.find(t => !t.available && (!busyTable || t.id !== busyTable.id)) ||
      null
    if (waitingTable) {
      const waitingCount = options.waitingCount ?? 3
      for (let i = 0; i < waitingCount; i++) {
        queueState.counters[waitingTable.id] = (queueState.counters[waitingTable.id] || 0) + 1
        const seq = queueState.counters[waitingTable.id]
        const id = `QT_seed_wait_${waitingTable.id}_${i}`
        queueState.tickets[id] = {
          id,
          ticketNo: formatTicketNo(waitingTable.id, seq),
          tableId: waitingTable.id,
          userId: `demo_wait_${i}`,
          userName: demoNames[i % demoNames.length],
          seq,
          status: QUEUE_STATUS.WAITING,
          graceMs: DEFAULT_CALLED_GRACE_MS,
          seatHoldMs: DEFAULT_SEAT_HOLD_MS,
          restoredAt: null,
          restoreSeq: null,
          calledAt: null,
          arrivedAt: null,
          seatedAt: null,
          completedAt: null,
          cancelledAt: null,
          missedAt: null,
          synced: true,
          createdAt: now - (waitingCount - i) * 60 * 1000
        }
        created = true
      }
    }

    if (created) {
      persist()
      try {
        localStorage.setItem(SEEDED_KEY, String(now))
      } catch (e) {
        /* ignore */
      }
    }
    return created
  }
}

/** 响应式便捷状态：在线状态、待同步数量（供模板直接使用） */
export const queueOnline = computed(() => queueState.online)
export const queuePendingCount = computed(() => queueState.outbox.length)

export default queueStore
