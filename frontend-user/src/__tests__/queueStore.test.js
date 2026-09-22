/**
 * 现场排队叫号模块单元测试
 *
 * 测试范围：
 * - 加入排队 / 重复排队 / 满员拦截
 * - 叫号 → 到场 → 开台 → 完成的状态流转，球桌可用状态联动
 * - 过号（自动/手动）与过号恢复，顺序保持不变
 * - 取消排队释放名额与球桌
 * - 断网期间本机排队（outbox），恢复后自动同步
 * - 持久化恢复：返回球桌页/重新初始化后顺序一致
 * - 预计等待时间 / 当前顺序计算
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { queueStore, queueState, QUEUE_CAPACITY_PER_TABLE, QUEUE_ERROR, ARRIVE_WINDOW_MS } from '../utils/queueStore'
import { authState } from '../utils/auth'

function loginAs(id = 'U-test', name = '测试用户') {
  authState.user = { id, name }
  authState.isLoggedIn = true
  authState.token = 'mock-token'
}

function logout() {
  authState.user = null
  authState.isLoggedIn = false
  authState.token = null
}

describe('Queue Store', () => {
  beforeEach(() => {
    vi.useRealTimers()
    queueStore.reset()
    localStorage.clear()
    queueStore.init()
    logout()
  })

  afterEach(() => {
    queueStore.reset()
    logout()
  })

  describe('加入排队', () => {
    it('未登录时拒绝排队', async () => {
      const result = await queueStore.joinQueue(2)
      expect(result.success).toBe(false)
      expect(result.code).toBe(QUEUE_ERROR.AUTH_REQUIRED)
    })

    it('登录后可加入排队并返回票号与预计等待', async () => {
      loginAs()
      const result = await queueStore.joinQueue(2)
      expect(result.success).toBe(true)
      expect(result.data.ticket.no).toMatch(/^T2-\d{3}$/)
      expect(result.data.ticket.status).toBe('waiting')
      expect(queueStore.getNewcomerWait(2)).toBeGreaterThan(0)
    })

    it('同一用户不能重复排队（跨桌也不行）', async () => {
      loginAs()
      const first = await queueStore.joinQueue(2)
      expect(first.success).toBe(true)
      const second = await queueStore.joinQueue(5)
      expect(second.success).toBe(false)
      expect(second.code).toBe(QUEUE_ERROR.DUPLICATE_QUEUE)
    })

    it('排队满员时拒绝加入', async () => {
      // 种子数据：2号桌已有3桌活跃（1桌使用中 + 2桌等待）
      for (let i = 0; i < QUEUE_CAPACITY_PER_TABLE - 3; i++) {
        loginAs(`user_${i}`, `用户${i}`)
        const r = await queueStore.joinQueue(2)
        expect(r.success).toBe(true)
      }
      loginAs('user_full', '满员用户')
      const result = await queueStore.joinQueue(2)
      expect(result.success).toBe(false)
      expect(result.code).toBe(QUEUE_ERROR.QUEUE_FULL)
      expect(queueStore.getBoard(2).full).toBe(true)
    })
  })

  describe('叫号状态流转与球桌可用状态', () => {
    it('排队 → 叫号 → 到场 → 开台 → 完成，完成后球桌恢复可用', async () => {
      const availBefore = queueStore.getTableAvailability(2, queueState.seedDate)
      expect(availBefore).toBe(false) // 2号桌今日有使用中的排队单

      // 店员先结束当前使用中的单据，球桌释放
      const board0 = queueStore.getBoard(2)
      expect(board0.currentCall.status).toBe('serving')
      expect(board0.canCallNext).toBe(false)
      await queueStore.completeService(board0.currentCall.id)

      loginAs('U-flow')
      const joined = await queueStore.joinQueue(2)
      const ticketId = joined.data.ticket.id

      // 叫到队首种子用户
      let r = await queueStore.callNext(2)
      expect(r.success).toBe(true)
      expect(r.data.ticket.no).toBe('T2-002')

      // 种子单结束后才叫到下一位
      await queueStore.markMissed(r.data.ticket.id)
      r = await queueStore.callNext(2)
      expect(r.data.ticket.no).toBe('T2-003')
      await queueStore.markMissed(r.data.ticket.id)
      r = await queueStore.callNext(2)
      expect(r.success).toBe(true)
      expect(r.data.ticket.id).toBe(ticketId)
      expect(r.data.ticket.status).toBe('called')

      // 叫号期间球桌不可预约
      expect(queueStore.getTableAvailability(2, queueState.seedDate)).toBe(false)
      expect(queueStore.getCallRemainingSeconds(ticketId)).toBeGreaterThan(0)

      // 到场
      r = await queueStore.checkIn(ticketId)
      expect(r.data.ticket.status).toBe('arrived')
      // 非叫号状态不能再确认到场
      const again = await queueStore.checkIn(ticketId)
      expect(again.success).toBe(false)

      // 开台
      r = await queueStore.startService(ticketId)
      expect(r.data.ticket.status).toBe('serving')
      expect(queueStore.getTableAvailability(2, queueState.seedDate)).toBe(false)

      // 完成并释放
      r = await queueStore.completeService(ticketId)
      expect(r.data.ticket.status).toBe('completed')
      // 种子单已结束、过号单不占用，球桌恢复可预约
      expect(queueStore.getTableAvailability(2, queueState.seedDate)).toBe(true)
    })

    it('当前号码未结束时不允许叫下一位', async () => {
      // 种子中2号桌当前为使用中（未结束），不能直接叫下一位
      const blocked = await queueStore.callNext(2)
      expect(blocked.success).toBe(false)
      expect(blocked.code).toBe(QUEUE_ERROR.CURRENT_NOT_RESOLVED)

      // 结束使用后可叫号，叫号中仍未结束时再次叫号同样被拒绝
      const board0 = queueStore.getBoard(2)
      await queueStore.completeService(board0.currentCall.id)
      const r1 = await queueStore.callNext(2)
      expect(r1.success).toBe(true)
      const r2 = await queueStore.callNext(2)
      expect(r2.success).toBe(false)
      expect(r2.code).toBe(QUEUE_ERROR.CURRENT_NOT_RESOLVED)
    })

    it('没有排队时叫号返回无等待', async () => {
      const r = await queueStore.callNext(1)
      expect(r.success).toBe(false)
      expect(r.code).toBe(QUEUE_ERROR.NO_WAITING_TICKET)
    })

    it('非排队中状态的票单不占顺序位置', async () => {
      loginAs('U-pos')
      const joined = await queueStore.joinQueue(2)
      const id = joined.data.ticket.id
      // 使用中的单据不在顺序行；种子已有 T2-002、T2-003 在前面
      expect(queueStore.getPosition(id)).toBe(3)
      await queueStore.cancelTicket(id)
      expect(queueStore.getPosition(id)).toBeNull()
    })
  })

  describe('过号与顺序恢复', () => {
    it('叫号超时自动过号，过号票保留原位置', async () => {
      vi.useFakeTimers()
      queueStore.reset()
      localStorage.clear()
      queueStore.init()

      // 先结束2号桌使用中的种子单
      const board0 = queueStore.getBoard(2)
      const release = queueStore.completeService(board0.currentCall.id)
      await vi.advanceTimersByTimeAsync(300)
      await release

      const calledP = queueStore.callNext(2)
      await vi.advanceTimersByTimeAsync(300)
      const called = await calledP
      expect(called.data.ticket.status).toBe('called')

      // 未超时仍是叫号中
      await vi.advanceTimersByTimeAsync(ARRIVE_WINDOW_MS - 1000)
      expect(queueStore.getTicket(called.data.ticket.id).status).toBe('called')

      // 超时自动过号
      await vi.advanceTimersByTimeAsync(2000)
      expect(queueStore.getTicket(called.data.ticket.id).status).toBe('missed')

      // 过号票仍在顺序行首位
      const board = queueStore.getBoard(2)
      expect(board.line[0].id).toBe(called.data.ticket.id)
      expect(board.line[0].status).toBe('missed')

      // 叫下一位时跳过过号票
      const nextP = queueStore.callNext(2)
      await vi.advanceTimersByTimeAsync(300)
      const next = await nextP
      expect(next.success).toBe(true)
      expect(next.data.ticket.no).toBe('T2-003')

      vi.useRealTimers()
    })

    it('过号恢复后回到原顺序位置', async () => {
      // 先结束2号桌使用中的种子单
      const board0 = queueStore.getBoard(2)
      await queueStore.completeService(board0.currentCall.id)

      const first = await queueStore.callNext(2)
      expect(first.data.ticket.no).toBe('T2-002')
      await queueStore.markMissed(first.data.ticket.id)

      // 过号票位于顺序行首位（位置1），可恢复
      loginAs('guest_li') // 种子 T2-002 的归属用户
      const posBefore = queueStore.getPosition(first.data.ticket.id)
      expect(posBefore).toBe(1)

      const restored = await queueStore.restoreTicket(first.data.ticket.id)
      expect(restored.success).toBe(true)
      expect(restored.data.ticket.status).toBe('waiting')
      expect(queueStore.getPosition(first.data.ticket.id)).toBe(1)

      // 恢复后叫号应再次叫到该号码
      const calledAgain = await queueStore.callNext(2)
      expect(calledAgain.data.ticket.no).toBe('T2-002')
    })

    it('不能恢复他人的排队', async () => {
      await queueStore.completeService(queueStore.getBoard(2).currentCall.id)
      const first = await queueStore.callNext(2)
      await queueStore.markMissed(first.data.ticket.id)
      loginAs('someone_else', '其他人')
      const r = await queueStore.restoreTicket(first.data.ticket.id)
      expect(r.success).toBe(false)
      expect(r.code).toBe(QUEUE_ERROR.INVALID_STATUS)
    })
  })

  describe('取消排队', () => {
    it('取消后释放名额，可再次排队', async () => {
      loginAs('U-cancel')
      const joined = await queueStore.joinQueue(2)
      expect(queueStore.getMyTicket()).not.toBeNull()
      const r = await queueStore.cancelTicket(joined.data.ticket.id)
      expect(r.success).toBe(true)
      expect(queueStore.getMyTicket()).toBeNull()

      // 取消后允许重新排队
      const again = await queueStore.joinQueue(2)
      expect(again.success).toBe(true)
    })

    it('已完成的票单不能取消', async () => {
      loginAs('U-done')
      const joined = await queueStore.joinQueue(2)
      const id = joined.data.ticket.id
      // 结束使用中的种子单，并让前面等待的种子用户都过号
      await queueStore.completeService(queueStore.getBoard(2).currentCall.id)
      const c1 = await queueStore.callNext(2)
      await queueStore.markMissed(c1.data.ticket.id)
      const c2 = await queueStore.callNext(2)
      await queueStore.markMissed(c2.data.ticket.id)
      await queueStore.callNext(2)
      await queueStore.checkIn(id)
      await queueStore.startService(id)
      await queueStore.completeService(id)
      const r = await queueStore.cancelTicket(id)
      expect(r.success).toBe(false)
    })
  })

  describe('断网与同步', () => {
    it('断网期间加入排队本机生效并进入待同步，恢复后自动清空 outbox', async () => {
      await queueStore.setOnline(false)
      expect(queueState.online).toBe(false)

      loginAs('U-offline')
      const r = await queueStore.joinQueue(2)
      expect(r.success).toBe(true)
      expect(r.offline).toBe(true)
      expect(queueState.outbox.length).toBe(1)
      expect(r.data.ticket.pending).toBe(true)

      // 断网期间顺序依然可用（前面有 T2-002、T2-003 两桌等待）
      expect(queueStore.getMyTicket()).not.toBeNull()
      expect(queueStore.getPosition(r.data.ticket.id)).toBe(3)

      await queueStore.setOnline(true)
      expect(queueState.outbox.length).toBe(0)
      expect(queueStore.getMyTicket().pending).toBe(false)
    })

    it('断网期间取消也会被缓存并在恢复后同步', async () => {
      loginAs('U-offline-cancel')
      const joined = await queueStore.joinQueue(2)
      await queueStore.setOnline(false)
      const r = await queueStore.cancelTicket(joined.data.ticket.id)
      expect(r.success).toBe(true)
      expect(queueState.outbox.length).toBe(1)
      expect(queueStore.getMyTicket()).toBeNull()
      await queueStore.setOnline(true)
      expect(queueState.outbox.length).toBe(0)
    })
  })

  describe('持久化与预计等待', () => {
    it('重新初始化（模拟返回球桌页）后排队顺序与待同步状态保持一致', () => {
      // 同步排队，写入存储
      const boardBefore = queueStore.getBoard(2)
      expect(boardBefore.waitingCount).toBe(2)

      // 直接重新初始化，从 localStorage 恢复
      queueStore.init(true)
      const boardAfter = queueStore.getBoard(2)
      expect(boardAfter.waitingCount).toBe(2)
      expect(boardAfter.line.map(t => t.no)).toEqual(['T2-002', 'T2-003'])
      // 使用中的种子单也被恢复，球桌仍不可预约
      expect(boardAfter.currentCall.no).toBe('T2-001')
      expect(queueStore.getTableAvailability(2, queueState.seedDate)).toBe(false)
    })

    it('排队中票单的预计等待随前面人数递减', async () => {
      // 先结束使用中的种子单，让队首可被呼叫
      await queueStore.completeService(queueStore.getBoard(2).currentCall.id)

      loginAs('U-wait')
      const joined = await queueStore.joinQueue(2)
      const id = joined.data.ticket.id
      const waitWithTwoAhead = queueStore.getEstimatedWait(id)
      expect(waitWithTwoAhead).toBeGreaterThanOrEqual(20)

      await queueStore.markMissed((await queueStore.callNext(2)).data.ticket.id)
      // 队首过号（保留位置但不再计入等待人数），等待时间应下降
      const waitAfterMissed = queueStore.getEstimatedWait(id)
      expect(waitAfterMissed).toBeLessThan(waitWithTwoAhead)
    })
  })
})
