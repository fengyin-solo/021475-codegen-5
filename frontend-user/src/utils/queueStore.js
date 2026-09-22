/**
 * 现场排队叫号存储管理
 *
 * 功能说明：
 * - 管理每张球桌的现场排队队列与叫号状态
 * - 排队状态机：排队中(waiting) → 叫号中(called) → 已到场(arrived) → 使用中(serving) → 已完成(completed)
 *               叫号中可流转为 已过号(missed)，过号后可恢复排队(restore)，排队中/叫号中可取消(cancelled)
 * - 顺序按取号序号(seq)排列，过号保留原序号，恢复后回到原顺序位置
 * - localStorage 持久化，断网期间操作先本机生效并进入待同步队列(outbox)，恢复后自动同步
 * - 球桌可预约状态 = 当日基础可用状态 且 没有正在叫号/已到场/使用中的排队单（完成服务即释放）
 */

import { reactive } from 'vue'
import { logger } from './api'
import { authState } from './auth'

// ==================== 常量定义 ====================

const STORAGE_KEY = 'billiard_user_queue'
const STORAGE_VERSION = 1

/** 每张球桌排队上限（含排队中、叫号中、已到场、使用中、已过号待恢复） */
export const QUEUE_CAPACITY_PER_TABLE = 10

/** 每桌平均每单预计耗时（分钟），用于预计等待时间估算 */
const AVG_MINUTES_PER_PARTY = 10

/** 预计等待最小值（分钟） */
const MIN_WAIT_MINUTES = 5

/** 叫号后到场核验时限（毫秒），超时自动过号。演示环境设为 60 秒 */
export const ARRIVE_WINDOW_MS = 60 * 1000

/** 自动巡检间隔（毫秒），用于叫号超时自动过号 */
const TICK_INTERVAL_MS = 1000

/** 模拟服务端同步延迟（毫秒） */
const SYNC_DELAY_MS = 200

/** 票号状态配置 */
export const QUEUE_STATUS = {
  waiting: { text: '排队中', type: 'info' },
  called: { text: '叫号中', type: 'warning' },
  arrived: { text: '已到场', type: 'primary' },
  serving: { text: '使用中', type: 'primary' },
  missed: { text: '已过号', type: 'danger' },
  cancelled: { text: '已取消', type: 'muted' },
  completed: { text: '已完成', type: 'success' }
}

/** 仍占用排队名额的活跃状态 */
const ACTIVE_STATUSES = ['waiting', 'called', 'arrived', 'serving', 'missed']

/** 占用球桌（球桌不可预约）的状态 */
const TABLE_BUSY_STATUSES = ['called', 'arrived', 'serving']

/** 排队顺序行内的状态（按序号排队，过号保留位置） */
const LINE_STATUSES = ['waiting', 'missed']

/** 业务错误码 */
export const QUEUE_ERROR = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  DUPLICATE_QUEUE: 'DUPLICATE_QUEUE',
  QUEUE_FULL: 'QUEUE_FULL',
  TICKET_NOT_FOUND: 'TICKET_NOT_FOUND',
  INVALID_STATUS: 'INVALID_STATUS',
  CURRENT_NOT_RESOLVED: 'CURRENT_NOT_RESOLVED',
  NO_WAITING_TICKET: 'NO_WAITING_TICKET'
}

/** 球桌基础信息（球桌预约页与排队共用同一数据源，保证价格/类型一致） */
export const TABLES = [
  { id: 1, name: '1号球桌', type: '斯诺克', typeId: 'snooker', price: 80, size: '12尺', brand: '星牌' },
  { id: 2, name: '2号球桌', type: '斯诺克', typeId: 'snooker', price: 80, size: '12尺', brand: '星牌' },
  { id: 3, name: '3号球桌', type: '美式九球', typeId: 'pool', price: 60, size: '9尺', brand: 'Brunswick' },
  { id: 4, name: '4号球桌', type: '美式九球', typeId: 'pool', price: 60, size: '9尺', brand: 'Brunswick' },
  { id: 5, name: '5号球桌', type: '中式八球', typeId: 'chinese', price: 50, size: '9尺', brand: '乔氏' },
  { id: 6, name: '6号球桌', type: '中式八球', typeId: 'chinese', price: 50, size: '9尺', brand: '乔氏' }
]

// ==================== 响应式状态 ====================

/**
 * 排队状态（响应式单例，刷新/路由切换后从 localStorage 恢复）
 *
 * @property {boolean} initialized - 是否已初始化
 * @property {boolean} online - 网络是否连通（可通过 setOnline 模拟断网）
 * @property {string} seedDate - 当前队列所属日期（本地 YYYY-MM-DD），跨天重新取号
 * @property {Object<number, number>} seq - 每张球桌的单调递增取号序号
 * @property {Object<number, Object>} tables - 每张球桌的队列 { tickets: [] }
 * @property {Array} outbox - 断网期间待同步的操作
 */
export const queueState = reactive({
  initialized: false,
  online: true,
  seedDate: '',
  seq: {},
  tables: {},
  outbox: []
})

// ==================== 事件订阅 ====================

const listeners = {}

/**
 * 订阅排队事件
 * @param {string} event - called(叫号)/missed(过号)/synced(同步完成)/online(网络变化)
 * @param {Function} handler - 处理函数
 * @returns {Function} 取消订阅函数
 */
function on(event, handler) {
  if (!listeners[event]) listeners[event] = []
  listeners[event].push(handler)
  return () => {
    listeners[event] = (listeners[event] || []).filter(fn => fn !== handler)
  }
}

function emit(event, payload) {
  ;(listeners[event] || []).forEach(handler => {
    try {
      handler(payload)
    } catch (e) {
      logger.error('Queue event handler error', e)
    }
  })
}

// ==================== 工具函数 ====================

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function pad(n) {
  return n.toString().padStart(2, '0')
}

/** 本地日期字符串 YYYY-MM-DD（避免 toISOString 的 UTC 偏移问题） */
export function todayString(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function uid(prefix = 'Q') {
  return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)
}

function formatTicketNo(tableId, seq) {
  return `T${tableId}-${seq.toString().padStart(3, '0')}`
}

/** 用户名脱敏，如 张三 -> 张* */
export function maskName(name) {
  if (!name) return '球友'
  return name.length > 1 ? name[0] + '*' : name
}

function getCurrentUser() {
  return authState.user || null
}

function fail(code, error) {
  logger.warn('Queue operation rejected', { code, error })
  return { success: false, code, error }
}

// ==================== 持久化 ====================

function persist() {
  try {
    const snapshot = {
      version: STORAGE_VERSION,
      online: queueState.online,
      seedDate: queueState.seedDate,
      seq: queueState.seq,
      tables: queueState.tables,
      outbox: queueState.outbox
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
    return true
  } catch (e) {
    logger.error('排队信息保存失败', e)
    return false
  }
}

function loadSnapshot() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const snapshot = JSON.parse(raw)
    if (!snapshot || snapshot.version !== STORAGE_VERSION) return null
    return snapshot
  } catch (e) {
    logger.error('排队信息加载失败', e)
    return null
  }
}

// ==================== 初始化与种子数据 ====================

/**
 * 初始化（幂等）：恢复本地持久化队列；首次进入或跨天时生成演示队列
 */
function init(force = false) {
  if (queueState.initialized && !force) return

  const snapshot = loadSnapshot()
  if (snapshot && snapshot.seedDate === todayString()) {
    queueState.online = snapshot.online !== false
    queueState.seedDate = snapshot.seedDate
    queueState.seq = snapshot.seq || {}
    queueState.tables = snapshot.tables || {}
    queueState.outbox = snapshot.outbox || []
  } else {
    seedToday()
    persist()
  }

  queueState.initialized = true
  startTicker()
  logger.info('现场排队已初始化', { seedDate: queueState.seedDate })
  flushOutbox()
}

/**
 * 生成今日演示排队数据：
 * - 2号桌（使用中）：2 桌排队中
 * - 5号桌（叫号中，到场时限即将演示自动过号）：1 桌排队中
 */
function seedToday() {
  const now = Date.now()
  queueState.online = true
  queueState.seedDate = todayString()
  queueState.seq = { 2: 3, 5: 2 }
  queueState.outbox = []
  queueState.tables = {
    2: {
      tickets: [
        makeTicket({
          tableId: 2,
          seq: 1,
          userId: 'guest_sun',
          userName: '孙*',
          status: 'serving',
          createdAt: now - 30 * 60000,
          servingAt: now - 25 * 60000
        }),
        makeTicket({
          tableId: 2,
          seq: 2,
          userId: 'guest_li',
          userName: '李*',
          status: 'waiting',
          createdAt: now - 10 * 60000
        }),
        makeTicket({
          tableId: 2,
          seq: 3,
          userId: 'guest_wang',
          userName: '王*',
          status: 'waiting',
          createdAt: now - 5 * 60000
        })
      ]
    },
    5: {
      tickets: [
        makeTicket({
          tableId: 5,
          seq: 1,
          userId: 'guest_zhao',
          userName: '赵*',
          status: 'called',
          createdAt: now - 10 * 60000,
          calledAt: now - 15000
        }),
        makeTicket({
          tableId: 5,
          seq: 2,
          userId: 'guest_chen',
          userName: '陈*',
          status: 'waiting',
          createdAt: now - 3 * 60000
        })
      ]
    }
  }
}

function makeTicket({ tableId, seq, userId, userName, status, createdAt, calledAt = null }) {
  return {
    id: uid(),
    no: formatTicketNo(tableId, seq),
    tableId,
    seq,
    userId,
    userName,
    status,
    createdAt,
    calledAt,
    arrivedAt: null,
    servingAt: null,
    finishedAt: null,
    pending: false
  }
}

/** 重置全部状态（测试使用） */
function reset() {
  stopTicker()
  queueState.initialized = false
  queueState.online = true
  queueState.seedDate = ''
  queueState.seq = {}
  queueState.tables = {}
  queueState.outbox = []
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch (e) {
    logger.warn('清除排队存储失败', e)
  }
}

// ==================== 查询辅助 ====================

function ensureTableQueue(tableId) {
  if (!queueState.tables[tableId]) {
    queueState.tables[tableId] = { tickets: [] }
  }
  if (queueState.seq[tableId] == null) queueState.seq[tableId] = 0
  return queueState.tables[tableId]
}

function findTicket(ticketId) {
  for (const tableId of Object.keys(queueState.tables)) {
    const tq = queueState.tables[tableId]
    const ticket = tq.tickets.find(t => t.id === ticketId)
    if (ticket) return { ticket, tableQueue: tq }
  }
  return null
}

function activeTickets(tableQueue) {
  return tableQueue.tickets.filter(t => ACTIVE_STATUSES.includes(t.status))
}

/** 顺序行：排队中 + 已过号（保留原位），按取号序号排列 */
function lineTickets(tableQueue) {
  return tableQueue.tickets.filter(t => LINE_STATUSES.includes(t.status)).sort((a, b) => a.seq - b.seq)
}

function getTicketView(ticket) {
  if (!ticket) return null
  const statusInfo = QUEUE_STATUS[ticket.status] || { text: ticket.status, type: 'info' }
  return {
    ...ticket,
    statusText: statusInfo.text,
    statusType: statusInfo.type
  }
}

// ==================== 模拟网络与同步 ====================

/**
 * 设置网络状态（演示/验收用）
 * 断网时所有操作本机立即生效并记入 outbox；恢复后自动同步
 */
async function setOnline(online) {
  if (queueState.online === online) return
  queueState.online = online
  persist()
  emit('online', online)
  logger.info(online ? '网络已恢复' : '网络已断开（模拟）')
  if (online) await flushOutbox()
}

/**
 * 将一次操作记入待同步队列；网络正常时立即尝试同步
 */
async function recordAction(action, payload, ticket) {
  queueState.outbox.push({ id: uid('O'), action, payload, at: Date.now() })
  if (ticket) ticket.pending = true
  persist()
  await flushOutbox()
}

/**
 * 尝试把待同步操作发送到服务端（模拟）
 * 断网时保留在 outbox，顺序不丢失，等待 setOnline(true) 后重试
 */
async function flushOutbox() {
  if (!queueState.online || queueState.outbox.length === 0) return
  await delay(SYNC_DELAY_MS)
  // 延迟期间可能再次断网
  if (!queueState.online || queueState.outbox.length === 0) return

  queueState.outbox.splice(0, queueState.outbox.length)
  Object.values(queueState.tables).forEach(tq => {
    tq.tickets.forEach(t => {
      t.pending = false
    })
  })
  persist()
  emit('synced')
  logger.info('排队待同步操作已全部同步')
}

// ==================== 自动巡检（叫号超时过号） ====================

let tickerTimer = null

function startTicker() {
  if (tickerTimer !== null) return
  tickerTimer = setInterval(tick, TICK_INTERVAL_MS)
}

function stopTicker() {
  if (tickerTimer !== null) {
    clearInterval(tickerTimer)
    tickerTimer = null
  }
}

/**
 * 巡检：叫号超过到场时限仍未到场的票自动转为已过号（顺序保留，可恢复）
 */
function tick() {
  if (!queueState.initialized) return
  const now = Date.now()
  let changed = false

  Object.values(queueState.tables).forEach(tq => {
    tq.tickets.forEach(ticket => {
      if (ticket.status === 'called' && ticket.calledAt && now - ticket.calledAt >= ARRIVE_WINDOW_MS) {
        ticket.status = 'missed'
        ticket.missedAt = now
        changed = true
        emit('missed', getTicketView(ticket))
        logger.info('叫号超时未到场，自动过号', { no: ticket.no, tableId: ticket.tableId })
      }
    })
  })

  if (changed) persist()
}

// ==================== 球桌可用状态 ====================

/**
 * 日期的稳定哈希值（同一日期+球桌每次访问结果一致，避免随机状态前后不一致）
 */
function stableHash(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

/**
 * 球桌在指定日期的基础可用状态（不含排队占用）
 * 今日：均视为基础可预约，占用完全由现场排队的进行中单据（叫号中/已到场/使用中）体现，
 *       店员结束服务后球桌立即释放，保证预约入口与排队状态始终一致
 * 其它日期：按日期+桌号稳定生成，同一日期重复访问结果一致
 */
function getBaseAvailability(tableId, dateStr) {
  if (dateStr === queueState.seedDate || dateStr === todayString()) {
    return true
  }
  return stableHash(`${dateStr}-${tableId}`) % 10 > 2
}

/** 球桌当前是否被叫号/到场/使用中的排队单占用 */
function isTableBusy(tableId) {
  const tq = queueState.tables[tableId]
  if (!tq) return false
  return tq.tickets.some(t => TABLE_BUSY_STATUSES.includes(t.status))
}

/**
 * 球桌在指定日期的有效可用状态（预约按钮与排队入口共用）
 * 今日还需排除排队占用；其它日期不考虑今日现场排队
 */
function getTableAvailability(tableId, dateStr) {
  init()
  if (!getBaseAvailability(tableId, dateStr)) return false
  if (dateStr === todayString()) return !isTableBusy(tableId)
  return true
}

// ==================== 队列查询视图 ====================

/**
 * 获取某桌排队看板信息
 * @returns {{currentCall: Object|null, line: Array, waitingCount: number, activeCount: number, canCallNext: boolean, full: boolean}}
 */
function getBoard(tableId) {
  init()
  const tq = ensureTableQueue(tableId)
  const line = lineTickets(tq).map(getTicketView)
  const currentCall = getTicketView(tq.tickets.find(t => TABLE_BUSY_STATUSES.includes(t.status)) || null)
  const waitingCount = tq.tickets.filter(t => t.status === 'waiting').length
  const activeCount = activeTickets(tq).length
  const blocked = tq.tickets.some(t => TABLE_BUSY_STATUSES.includes(t.status))

  return {
    tableId,
    currentCall,
    line,
    waitingCount,
    activeCount,
    canCallNext: !blocked && waitingCount > 0,
    full: activeCount >= QUEUE_CAPACITY_PER_TABLE
  }
}

/** 获取指定用户进行中的排队单（全局至多一张） */
function getMyTicketById(userId) {
  if (!userId) return null
  for (const tq of Object.values(queueState.tables)) {
    const ticket = tq.tickets.find(t => t.userId === userId && ACTIVE_STATUSES.includes(t.status))
    if (ticket) return ticket
  }
  return null
}

/** 获取当前用户进行中的排队单视图 */
function getMyTicket(userId) {
  init()
  const id = userId || getCurrentUser()?.id
  if (!id) return null
  return getTicketView(getMyTicketById(id))
}

function getTicket(ticketId) {
  init()
  const found = findTicket(ticketId)
  return found ? getTicketView(found.ticket) : null
}

/**
 * 票单在排队顺序行中的位置（从 1 开始）；非排队中/已过号返回 null
 */
function getPosition(ticketId) {
  const found = findTicket(ticketId)
  if (!found || !LINE_STATUSES.includes(found.ticket.status)) return null
  const line = lineTickets(found.tableQueue)
  const index = line.findIndex(t => t.id === ticketId)
  return index === -1 ? null : index + 1
}

/**
 * 票单预计等待分钟数
 * - 排队中/已过号：顺序行中前面的等待桌数 × 平均每单耗时（至少 5 分钟）
 * - 叫号中：0（请立即到场）
 * - 已到场/使用中：0
 */
function getEstimatedWait(ticketId) {
  const found = findTicket(ticketId)
  if (!found) return null
  const { ticket, tableQueue } = found
  if (['called', 'arrived', 'serving'].includes(ticket.status)) return 0
  if (!LINE_STATUSES.includes(ticket.status)) return null
  const line = lineTickets(tableQueue)
  const index = line.findIndex(t => t.id === ticketId)
  const ahead = line.slice(0, index).filter(t => t.status === 'waiting').length
  return Math.max(MIN_WAIT_MINUTES, ahead * AVG_MINUTES_PER_PARTY)
}

/** 新取号用户的预计等待分钟数 */
function getNewcomerWait(tableId) {
  init()
  const tq = ensureTableQueue(tableId)
  const waitingCount = tq.tickets.filter(t => t.status === 'waiting').length
  return Math.max(MIN_WAIT_MINUTES, waitingCount * AVG_MINUTES_PER_PARTY)
}

/** 叫号剩余核验秒数（用于倒计时） */
function getCallRemainingSeconds(ticketId) {
  const found = findTicket(ticketId)
  if (!found || found.ticket.status !== 'called' || !found.ticket.calledAt) return 0
  return Math.max(0, Math.ceil((ARRIVE_WINDOW_MS - (Date.now() - found.ticket.calledAt)) / 1000))
}

// ==================== 用户操作 ====================

/**
 * 加入现场排队
 * @param {number} tableId - 球桌ID
 * @returns {Promise<{success: boolean, code?: string, error?: string, data?: {ticket}, offline?: boolean}>}
 */
async function joinQueue(tableId) {
  init()
  const user = getCurrentUser()
  if (!user) {
    return fail(QUEUE_ERROR.AUTH_REQUIRED, '请先登录后再排队')
  }

  // 重复排队校验：同一用户全局只能有一张活跃排队单
  const existing = getMyTicketById(user.id)
  if (existing) {
    const table = TABLES.find(t => t.id === existing.tableId)
    return fail(
      QUEUE_ERROR.DUPLICATE_QUEUE,
      `您已有进行中的排队（${table ? table.name : ''} ${existing.no}），请勿重复排队`
    )
  }

  const tq = ensureTableQueue(tableId)

  // 满员校验
  if (activeTickets(tq).length >= QUEUE_CAPACITY_PER_TABLE) {
    return fail(QUEUE_ERROR.QUEUE_FULL, '该球桌排队人数已满，请稍后再试')
  }

  const seq = (queueState.seq[tableId] || 0) + 1
  queueState.seq[tableId] = seq
  const ticket = makeTicket({
    tableId,
    seq,
    userId: user.id,
    userName: maskName(user.name),
    status: 'waiting',
    createdAt: Date.now()
  })
  tq.tickets.push(ticket)

  await recordAction('join', { tableId, ticketNo: ticket.no, userId: user.id, at: ticket.createdAt }, ticket)

  logger.info('排队成功', { no: ticket.no, tableId, offline: !queueState.online })
  return { success: true, data: { ticket: getTicketView(ticket) }, offline: !queueState.online }
}

/** 用户到场确认：叫号中 → 已到场 */
async function checkIn(ticketId) {
  init()
  const found = findTicket(ticketId)
  if (!found) return fail(QUEUE_ERROR.TICKET_NOT_FOUND, '排队记录不存在')
  const { ticket } = found
  if (ticket.status !== 'called') {
    return fail(QUEUE_ERROR.INVALID_STATUS, '当前状态不可确认到场')
  }
  ticket.status = 'arrived'
  ticket.arrivedAt = Date.now()
  await recordAction('check_in', { ticketNo: ticket.no, tableId: ticket.tableId }, ticket)
  logger.info('用户已到场', { no: ticket.no })
  return { success: true, data: { ticket: getTicketView(ticket) }, offline: !queueState.online }
}

/** 取消排队：排队中/叫号中/已到场/已过号 → 已取消，释放名额与占用 */
async function cancelTicket(ticketId) {
  init()
  const found = findTicket(ticketId)
  if (!found) return fail(QUEUE_ERROR.TICKET_NOT_FOUND, '排队记录不存在')
  const { ticket } = found
  if (!ACTIVE_STATUSES.includes(ticket.status)) {
    return fail(QUEUE_ERROR.INVALID_STATUS, '当前排队状态不可取消')
  }
  ticket.status = 'cancelled'
  ticket.finishedAt = Date.now()
  await recordAction('cancel', { ticketNo: ticket.no, tableId: ticket.tableId }, ticket)
  logger.info('排队已取消', { no: ticket.no })
  return { success: true, data: { ticket: getTicketView(ticket) }, offline: !queueState.online }
}

/**
 * 过号恢复：已过号 → 排队中
 * 票号与取号序号不变，因此回到顺序行中的原位置
 */
async function restoreTicket(ticketId) {
  init()
  const user = getCurrentUser()
  if (!user) return fail(QUEUE_ERROR.AUTH_REQUIRED, '请先登录后再操作')

  // 恢复同样受“一人一单”限制，但允许恢复自己这张过号单
  const existing = getMyTicketById(user.id)
  if (existing && existing.id !== ticketId) {
    return fail(QUEUE_ERROR.DUPLICATE_QUEUE, '您已有其他进行中的排队，无法恢复该号码')
  }

  const found = findTicket(ticketId)
  if (!found) return fail(QUEUE_ERROR.TICKET_NOT_FOUND, '排队记录不存在')
  const { ticket } = found
  if (ticket.status !== 'missed') {
    return fail(QUEUE_ERROR.INVALID_STATUS, '只有已过号的排队可以恢复')
  }
  if (ticket.userId !== user.id) {
    return fail(QUEUE_ERROR.INVALID_STATUS, '只能恢复本人的排队号码')
  }

  ticket.status = 'waiting'
  ticket.restoredAt = Date.now()
  await recordAction('restore', { ticketNo: ticket.no, tableId: ticket.tableId }, ticket)
  logger.info('过号已恢复，回到原排队位置', { no: ticket.no, seq: ticket.seq })
  return { success: true, data: { ticket: getTicketView(ticket) }, offline: !queueState.online }
}

// ==================== 店员操作（现场叫号，页面内提供模拟入口） ====================

/**
 * 叫下一位：队首排队中 → 叫号中
 * 若当前仍有叫号中/已到场/使用中的单据未结束，拒绝叫号以保证顺序一致
 */
async function callNext(tableId) {
  init()
  const tq = ensureTableQueue(tableId)

  const blocked = tq.tickets.find(t => TABLE_BUSY_STATUSES.includes(t.status))
  if (blocked) {
    return fail(
      QUEUE_ERROR.CURRENT_NOT_RESOLVED,
      `当前号码 ${blocked.no} 尚未结束（${QUEUE_STATUS[blocked.status].text}）`
    )
  }

  // 队首排队中（已过号的单据跳过，等待用户恢复后再叫）
  const next = lineTickets(tq).find(t => t.status === 'waiting')
  if (!next) {
    return fail(QUEUE_ERROR.NO_WAITING_TICKET, '暂无需叫号的排队')
  }

  next.status = 'called'
  next.calledAt = Date.now()
  await recordAction('call_next', { tableId, ticketNo: next.no }, next)
  emit('called', getTicketView(next))
  logger.info('叫号', { no: next.no, tableId })
  return { success: true, data: { ticket: getTicketView(next) }, offline: !queueState.online }
}

/** 店员标记过号：叫号中 → 已过号（保留顺序，可恢复） */
async function markMissed(ticketId) {
  init()
  const found = findTicket(ticketId)
  if (!found) return fail(QUEUE_ERROR.TICKET_NOT_FOUND, '排队记录不存在')
  const { ticket } = found
  if (ticket.status !== 'called') {
    return fail(QUEUE_ERROR.INVALID_STATUS, '仅叫号中的排队可以标记过号')
  }
  ticket.status = 'missed'
  ticket.missedAt = Date.now()
  await recordAction('mark_missed', { ticketNo: ticket.no, tableId: ticket.tableId }, ticket)
  emit('missed', getTicketView(ticket))
  logger.info('店员标记过号', { no: ticket.no })
  return { success: true, data: { ticket: getTicketView(ticket) }, offline: !queueState.online }
}

/** 店员确认开台：已到场 → 使用中 */
async function startService(ticketId) {
  init()
  const found = findTicket(ticketId)
  if (!found) return fail(QUEUE_ERROR.TICKET_NOT_FOUND, '排队记录不存在')
  const { ticket } = found
  if (ticket.status !== 'arrived') {
    return fail(QUEUE_ERROR.INVALID_STATUS, '仅已到场的排队可以开台')
  }
  ticket.status = 'serving'
  ticket.servingAt = Date.now()
  await recordAction('start_service', { ticketNo: ticket.no, tableId: ticket.tableId }, ticket)
  logger.info('确认开台，开始使用', { no: ticket.no })
  return { success: true, data: { ticket: getTicketView(ticket) }, offline: !queueState.online }
}

/** 店员完成服务：使用中 → 已完成，球桌释放为可用 */
async function completeService(ticketId) {
  init()
  const found = findTicket(ticketId)
  if (!found) return fail(QUEUE_ERROR.TICKET_NOT_FOUND, '排队记录不存在')
  const { ticket } = found
  if (ticket.status !== 'serving') {
    return fail(QUEUE_ERROR.INVALID_STATUS, '仅使用中的排队可以完成服务')
  }
  ticket.status = 'completed'
  ticket.finishedAt = Date.now()
  await recordAction('complete_service', { ticketNo: ticket.no, tableId: ticket.tableId }, ticket)
  logger.info('服务完成，球桌已释放', { no: ticket.no })
  return { success: true, data: { ticket: getTicketView(ticket) }, offline: !queueState.online }
}

// ==================== 导出 ====================

export const queueStore = {
  // 状态与常量
  state: queueState,
  statusConfig: QUEUE_STATUS,
  errorCode: QUEUE_ERROR,
  tables: TABLES,
  // 生命周期
  init,
  reset,
  destroy: stopTicker,
  on,
  // 网络（模拟）
  setOnline,
  flushOutbox,
  // 球桌可用状态
  getBaseAvailability,
  getTableAvailability,
  isTableBusy,
  // 查询
  getBoard,
  getMyTicket,
  getTicket,
  getPosition,
  getEstimatedWait,
  getNewcomerWait,
  getCallRemainingSeconds,
  // 用户操作
  joinQueue,
  checkIn,
  cancelTicket,
  restoreTicket,
  // 店员操作
  callNext,
  markMissed,
  startService,
  completeService
}

export default queueStore
