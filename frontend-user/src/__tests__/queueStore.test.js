/**
 * 现场排队叫号存储单元测试
 *
 * 测试范围：
 * - 取号排队、重复排队、满员
 * - 叫号 / 到场 / 过号 / 过号恢复（顺序可恢复）
 * - 取消后顺序前移
 * - 网络中断本地生效 + 恢复后补同步
 * - 持久化与刷新恢复
 * - 模拟流转（自动叫号、超时过号、就坐完成释放球桌）
 * - 球桌可用状态一致性
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { queueStore, QUEUE_STATUS, QUEUE_ERRORS } from '../utils/queueStore'

// 立即完成的远程操作，消除 mock 网络延迟
function installImmediateRemote() {
  queueStore.setRemote(async (op, payload) => ({ ok: true, op, ...payload }))
}

describe('Queue Store', () => {
  beforeEach(() => {
    queueStore.reset()
    queueStore.setOnline(true)
    installImmediateRemote()
  })

  // ---------- 取号 ----------

  describe('joinQueue', () => {
    it('取号成功，返回排队号与队首位置', async () => {
      const ticket = await queueStore.joinQueue(2, { userId: 'me', userName: '张三' })

      expect(ticket).toBeTruthy()
      expect(ticket.ticketNo).toMatch(/^B\d{3}$/)
      expect(ticket.status).toBe(QUEUE_STATUS.WAITING)
      expect(ticket.position).toBe(1)
      expect(ticket.statusText).toBe('排队中')
      expect(ticket.estimatedWaitMinutes).toBe(0)
      expect(ticket.synced).toBe(true)
    })

    it('多张票按取号顺序排队，位置与预计等待递增', async () => {
      await queueStore.joinQueue(5, { userId: 'u1' })
      await queueStore.joinQueue(5, { userId: 'u2' })
      const mine = await queueStore.joinQueue(5, { userId: 'me' })

      expect(mine.position).toBe(3)
      // 前 2 位 × 15 分钟
      expect(mine.estimatedWaitMinutes).toBe(30)

      const view = queueStore.getTableView(5)
      expect(view.queueList.map(t => t.position)).toEqual([1, 2, 3])
      expect(view.count).toBe(3)
    })

    it('同一用户不能对同一球桌重复排队', async () => {
      await queueStore.joinQueue(2, { userId: 'me' })

      await expect(queueStore.joinQueue(2, { userId: 'me' })).rejects.toMatchObject({
        message: QUEUE_ERRORS.ALREADY_JOINED,
        code: 'ALREADY_JOINED'
      })
    })

    it('同一用户可在不同球桌分别排队', async () => {
      const t2 = await queueStore.joinQueue(2, { userId: 'me' })
      const t5 = await queueStore.joinQueue(5, { userId: 'me' })

      expect(t2.tableId).toBe(2)
      expect(t5.tableId).toBe(5)
      expect(queueStore.getMyActiveTickets('me')).toHaveLength(2)
    })

    it('排队满员（10 人）时拒绝取号', async () => {
      for (let i = 0; i < 10; i++) {
        await queueStore.joinQueue(3, { userId: `u${i}` })
      }
      expect(queueStore.isQueueFull(3)).toBe(true)

      await expect(queueStore.joinQueue(3, { userId: 'me' })).rejects.toMatchObject({
        code: 'QUEUE_FULL'
      })
    })
  })

  // ---------- 叫号 / 到场 ----------

  describe('callNext & markArrived', () => {
    it('队首自动叫号，后续票位置前移', async () => {
      await queueStore.joinQueue(2, { userId: 'u1' })
      const mine = await queueStore.joinQueue(2, { userId: 'me' })
      expect(mine.position).toBe(2)

      const called = await queueStore.callNext(2)
      expect(called.userId).toBe('u1')
      expect(called.status).toBe(QUEUE_STATUS.CALLED)

      const mineAfter = queueStore.getTicket(mine.id)
      expect(mineAfter.position).toBe(2)
      expect(queueStore.getTableView(2).calling.ticketNo).toBe(called.ticketNo)
    })

    it('已叫号票到场后状态正确流转', async () => {
      await queueStore.joinQueue(2, { userId: 'me' })
      const called = await queueStore.callNext(2)

      const arrived = await queueStore.markArrived(called.id)
      expect(arrived.status).toBe(QUEUE_STATUS.ARRIVED)
      expect(arrived.statusText).toBe('已到场')
      expect(arrived.position).toBe(1)
      expect(queueStore.getCallingTicket(2)).toBeNull()
    })

    it('非叫号状态不能到场', async () => {
      const ticket = await queueStore.joinQueue(2, { userId: 'me' })
      await expect(queueStore.markArrived(ticket.id)).rejects.toMatchObject({
        code: 'INVALID_TRANSITION'
      })
    })
  })

  // ---------- 过号 / 恢复（顺序可恢复） ----------

  describe('miss & restore', () => {
    it('过号后让出位置，后续票前移', async () => {
      await queueStore.joinQueue(2, { userId: 'u1' })
      const mine = await queueStore.joinQueue(2, { userId: 'me' })
      await queueStore.joinQueue(2, { userId: 'u2' })

      const called = await queueStore.callNext(2)
      await queueStore.markMissed(called.id)

      expect(queueStore.getTicket(called.id).status).toBe(QUEUE_STATUS.MISSED)
      // u1 不再占活跃名额，我升到第 1 位
      expect(queueStore.getTicket(mine.id).position).toBe(1)
      expect(queueStore.getQueueCount(2)).toBe(2)
      expect(queueStore.getMissedTicket(2, 'u1')).toBeTruthy()
    })

    it('过号恢复后回到队首，排在普通等待票之前', async () => {
      await queueStore.joinQueue(2, { userId: 'u1' })
      await queueStore.joinQueue(2, { userId: 'me' })
      await queueStore.joinQueue(2, { userId: 'u2' })

      const first = await queueStore.callNext(2) // 叫 u1
      await queueStore.markMissed(first.id)       // u1 过号

      // 此时我位于队首
      expect(queueStore.getMyTicket(2, 'me').position).toBe(1)

      // u1 恢复：插到普通等待票之前，但不影响已叫号者（当前无叫号者，故为第 1 位）
      const restored = await queueStore.restoreTicket(first.id)
      expect(restored.status).toBe(QUEUE_STATUS.WAITING)
      expect(restored.restoredAt).toBeTruthy()
      expect(restored.position).toBe(1)

      const mineAfter = queueStore.getMyTicket(2, 'me')
      expect(mineAfter.position).toBe(2)

      const view = queueStore.getTableView(2)
      expect(view.waiting[0].ticketNo).toBe(first.ticketNo)
      expect(view.waiting[0].restoredAt).toBeTruthy()
    })

    it('已叫号者存在时，恢复票排在其后', async () => {
      await queueStore.joinQueue(2, { userId: 'u1' })
      await queueStore.joinQueue(2, { userId: 'me' })

      const first = await queueStore.callNext(2) // 叫 u1
      await queueStore.markMissed(first.id)      // u1 过号
      const mineCalled = await queueStore.callNext(2) // 我被叫号
      expect(mineCalled.userId).toBe('me')

      // u1 恢复：不能插到已叫号的我前面
      const restored = await queueStore.restoreTicket(first.id)
      expect(restored.position).toBe(2)
      expect(queueStore.getMyTicket(2, 'me').position).toBe(1)
    })

    it('多张过号票按恢复先后排序', async () => {
      await queueStore.joinQueue(2, { userId: 'a' })
      await queueStore.joinQueue(2, { userId: 'b' })
      await queueStore.joinQueue(2, { userId: 'c' })

      const c1 = await queueStore.callNext(2) // a 叫号
      await queueStore.markMissed(c1.id)
      const c2 = await queueStore.callNext(2) // b 叫号
      await queueStore.markMissed(c2.id)

      // b 先恢复、a 后恢复：b 应在 a 之前
      await queueStore.restoreTicket(c2.id)
      await queueStore.restoreTicket(c1.id)

      const waiting = queueStore.getTableView(2).waiting
      expect(waiting[0].userId).toBe('b')
      expect(waiting[1].userId).toBe('a')
      expect(waiting[2].userId).toBe('c')
    })

    it('非过号状态不能恢复', async () => {
      const ticket = await queueStore.joinQueue(2, { userId: 'me' })
      await expect(queueStore.restoreTicket(ticket.id)).rejects.toMatchObject({
        code: 'INVALID_TRANSITION'
      })
    })
  })

  // ---------- 取消 ----------

  describe('cancelTicket', () => {
    it('取消后后续票顺序前移，且可重新排队', async () => {
      await queueStore.joinQueue(2, { userId: 'u1' })
      const mine = await queueStore.joinQueue(2, { userId: 'me' })
      expect(queueStore.getTicket(mine.id).position).toBe(2)

      const head = await queueStore.callNext(2)
      await queueStore.cancelTicket(head.id)

      expect(queueStore.getTicket(head.id).status).toBe(QUEUE_STATUS.CANCELLED)
      expect(queueStore.getTicket(mine.id).position).toBe(1)

      // u1 已无活跃票，可重新取号
      const again = await queueStore.joinQueue(2, { userId: 'u1' })
      expect(again.status).toBe(QUEUE_STATUS.WAITING)
    })

    it('使用中状态不能直接取消', async () => {
      await queueStore.joinQueue(2, { userId: 'u1' })
      const called = await queueStore.callNext(2)
      await queueStore.markArrived(called.id)
      await queueStore.markSeated(called.id)

      await expect(queueStore.cancelTicket(called.id)).rejects.toMatchObject({
        code: 'INVALID_TRANSITION'
      })
    })
  })

  // ---------- 就坐 / 完成 / 球桌可用状态 ----------

  describe('seated & complete', () => {
    it('到场就坐后球桌占用，完成后释放恢复可用', async () => {
      expect(queueStore.isTableBusy(2)).toBe(false)

      await queueStore.joinQueue(2, { userId: 'u1' })
      const called = await queueStore.callNext(2)
      await queueStore.markArrived(called.id)
      await queueStore.markSeated(called.id)

      expect(queueStore.isTableBusy(2)).toBe(true)
      expect(queueStore.getTicket(called.id).status).toBe(QUEUE_STATUS.SEATED)

      await queueStore.completeTicket(called.id)
      expect(queueStore.isTableBusy(2)).toBe(false)
      expect(queueStore.getTicket(called.id).status).toBe(QUEUE_STATUS.COMPLETED)
    })

    it('非到场状态不能就坐', async () => {
      const ticket = await queueStore.joinQueue(2, { userId: 'me' })
      await expect(queueStore.markSeated(ticket.id)).rejects.toMatchObject({
        code: 'INVALID_TRANSITION'
      })
    })
  })

  // ---------- 网络中断 ----------

  describe('offline & outbox', () => {
    it('断网取号本地立即生效，操作进入发件箱', async () => {
      await queueStore.setOnline(false)
      const ticket = await queueStore.joinQueue(2, { userId: 'me' })

      expect(ticket.status).toBe(QUEUE_STATUS.WAITING)
      expect(ticket.position).toBe(1)
      expect(ticket.pendingSync).toBe(true)
      expect(queueStore.pendingSyncCount).toBe(1)
      expect(queueStore.getMyTicket(2)).toBeTruthy()
    })

    it('断网期间状态流转与顺序正常，恢复后按顺序补同步', async () => {
      await queueStore.setOnline(false)
      const t1 = await queueStore.joinQueue(2, { userId: 'u1' })
      const t2 = await queueStore.joinQueue(2, { userId: 'me' })

      // 断网下直接本地流转
      await queueStore.callNext(2)
      await queueStore.cancelTicket(t1.id)
      expect(queueStore.getTicket(t2.id).position).toBe(1)
      expect(queueStore.pendingSyncCount).toBe(4) // join ×2 + call + cancel

      // 记录远程调用顺序
      const ops = []
      queueStore.setRemote(async op => {
        ops.push(op)
        return { ok: true }
      })

      const result = await queueStore.setOnline(true)
      expect(result.remaining).toBe(0)
      expect(queueStore.pendingSyncCount).toBe(0)
      expect(ops).toContain('join')
      expect(ops).toContain('cancel')
      // 恢复后仍处于队首
      expect(queueStore.getTicket(t2.id).position).toBe(1)
    })

    it('在线时远程失败，操作进入发件箱且本地状态不回滚', async () => {
      queueStore.setRemote(async () => {
        throw new Error('network down')
      })
      const ticket = await queueStore.joinQueue(2, { userId: 'me' })

      expect(ticket).toBeTruthy()
      expect(queueStore.pendingSyncCount).toBe(1)
      expect(queueStore.getMyTicket(2)).toBeTruthy()
    })

    it('补同步中途再次失败时保留剩余操作，顺序不丢', async () => {
      await queueStore.setOnline(false)
      await queueStore.joinQueue(2, { userId: 'u1' })
      await queueStore.joinQueue(2, { userId: 'u2' })

      let calls = 0
      queueStore.setRemote(async () => {
        calls += 1
        if (calls === 2) throw new Error('still offline')
        return { ok: true }
      })

      const result = await queueStore.setOnline(true)
      expect(result.remaining).toBe(1)
      expect(queueStore.pendingSyncCount).toBe(1)

      // 再次恢复，剩余操作可继续同步
      installImmediateRemote()
      const retry = await queueStore.setOnline(true)
      expect(retry.remaining).toBe(0)
    })
  })

  // ---------- 持久化 ----------

  describe('persistence', () => {
    it('重新加载状态后排队号、顺序与状态保持一致', async () => {
      await queueStore.joinQueue(5, { userId: 'u1' })
      await queueStore.joinQueue(5, { userId: 'me' })
      const called = await queueStore.callNext(5)
      expect(called.ticketNo).toBe('E001')

      // 模拟刷新：重新从 localStorage 恢复
      queueStore.init()

      const view = queueStore.getTableView(5)
      expect(view.count).toBe(2)
      expect(view.calling.ticketNo).toBe('E001')
      expect(queueStore.getMyTicket(5).ticketNo).toBe('E002')
      expect(queueStore.getMyTicket(5).position).toBe(2)

      // 计数器继续递增，不复用号码
      const t3 = await queueStore.joinQueue(5, { userId: 'u3' })
      expect(t3.ticketNo).toBe('E003')
    })
  })

  // ---------- 模拟流转 ----------

  describe('advanceSimulation', () => {
    it('自动叫号队首；超时过号；过号票恢复后重新可叫', async () => {
      await queueStore.joinQueue(2, { userId: 'me', graceMs: 1000 })
      const t0 = Date.now()

      // 队首自动被叫号
      const e1 = queueStore.advanceSimulation(t0)
      expect(e1.some(e => e.type === 'called' && e.isSelf)).toBe(true)
      expect(queueStore.getMyTicket(2).status).toBe(QUEUE_STATUS.CALLED)

      // 未超时不变化
      expect(queueStore.advanceSimulation(t0 + 500).some(e => e.type === 'missed')).toBe(false)

      // 超时自动过号
      const e3 = queueStore.advanceSimulation(t0 + 1001)
      expect(e3.some(e => e.type === 'missed' && e.isSelf)).toBe(true)
      expect(queueStore.getMissedTicket(2).status).toBe(QUEUE_STATUS.MISSED)

      // 恢复后下一轮再次被叫
      await queueStore.restoreTicket(queueStore.getMissedTicket(2).id)
      const e4 = queueStore.advanceSimulation(t0 + 2000)
      expect(e4.some(e => e.type === 'called' && e.isSelf)).toBe(true)
    })

    it('其他顾客自动到场、就坐、到时完成并释放球桌', async () => {
      await queueStore.joinQueue(2, {
        userId: 'u1',
        graceMs: 1000,
        seatHoldMs: 5000
      })
      const t0 = Date.now()

      queueStore.advanceSimulation(t0) // called
      expect(queueStore.getCallingTicket(2)).toBeTruthy()

      const eArrive = queueStore.advanceSimulation(t0 + 500) // 自动到场（40% 时限），同轮引导就坐
      expect(eArrive.some(e => e.type === 'arrived')).toBe(true)
      expect(eArrive.some(e => e.type === 'seated')).toBe(true)
      expect(queueStore.isTableBusy(2)).toBe(true)

      queueStore.advanceSimulation(t0 + 6001) // 完成释放
      expect(queueStore.isTableBusy(2)).toBe(false)
      expect(queueStore.getQueueCount(2)).toBe(0)
    })

    it('前面的人取消/过号后，模拟叫号会顺延到下一位', async () => {
      await queueStore.joinQueue(2, { userId: 'u1', graceMs: 500 })
      const mine = await queueStore.joinQueue(2, { userId: 'me', graceMs: 5000 })
      const t0 = Date.now()

      queueStore.advanceSimulation(t0) // u1 叫号
      queueStore.advanceSimulation(t0 + 501) // u1 过号
      queueStore.advanceSimulation(t0 + 600) // 我被叫号

      expect(queueStore.getTicket(mine.id).status).toBe(QUEUE_STATUS.CALLED)
    })
  })

  // ---------- 演示数据 ----------

  describe('seedDemoData', () => {
    it('预置占用桌与等待队列，且不重复播种', () => {
      const tables = [
        { id: 1, available: false },
        { id: 2, available: true }
      ]
      const seeded = queueStore.seedDemoData(tables, { busyTableId: 1, waitingTableId: 1 })
      expect(seeded).toBe(true)
      expect(queueStore.isTableBusy(1)).toBe(true)
      expect(queueStore.getQueueCount(1)).toBe(4) // 1 使用中 + 3 等待

      // 再次播种无效
      expect(queueStore.seedDemoData(tables)).toBe(false)
    })
  })

  // ---------- 异常入参 ----------

  describe('invalid operations', () => {
    it('操作不存在的票返回 TICKET_NOT_FOUND', async () => {
      await expect(queueStore.markArrived('nope')).rejects.toMatchObject({
        code: 'TICKET_NOT_FOUND'
      })
      await expect(queueStore.cancelTicket('nope')).rejects.toMatchObject({
        code: 'TICKET_NOT_FOUND'
      })
      await expect(queueStore.restoreTicket('nope')).rejects.toMatchObject({
        code: 'TICKET_NOT_FOUND'
      })
    })
  })
})
