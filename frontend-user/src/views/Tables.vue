<template>
  <div class="tables-page">
    <header class="page-header">
      <div class="header-content">
        <span class="page-tag">在线预约</span>
        <h1>球桌预约</h1>
        <p>选择您喜欢的球桌类型，开始您的台球时光</p>
      </div>
    </header>

    <div class="filter-section">
      <div class="filter-group">
        <div class="filter-tabs">
          <button
            v-for="type in tableTypes"
            :key="type.id"
            :class="{ active: selectedType === type.id }"
            @click="selectedType = type.id"
          >
            <span class="tab-icon">{{ type.icon }}</span>
            <span>{{ type.name }}</span>
          </button>
        </div>
      </div>
      <div class="filter-right">
        <div class="date-picker">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
          <input v-model="selectedDate" type="date" />
        </div>
      </div>
    </div>

    <div class="tables-grid" :class="{ loading: isLoadingTables }">
      <div v-if="isLoadingTables" class="loading-overlay">
        <div class="loading-spinner"></div>
        <span>加载中...</span>
      </div>
      <div
        v-for="table in filteredTables"
        :key="table.id"
        class="table-card"
        :class="{ available: table.available, unavailable: !table.available }"
      >
        <div class="card-header">
          <div class="table-type-badge">{{ table.type }}</div>
          <div class="status-indicator" :class="table.available ? 'online' : 'offline'">
            <span class="status-dot"></span>
            <span>{{ table.available ? '可预约' : '已占用' }}</span>
          </div>
        </div>

        <div class="table-visual">
          <div class="table-3d">
            <div class="table-surface">
              <div class="pocket tl"></div>
              <div class="pocket tr"></div>
              <div class="pocket ml"></div>
              <div class="pocket mr"></div>
              <div class="pocket bl"></div>
              <div class="pocket br"></div>
            </div>
          </div>
        </div>

        <div class="card-content">
          <h3>{{ table.name }}</h3>
          <div class="table-specs">
            <div class="spec">
              <span class="spec-label">尺寸</span>
              <span class="spec-value">{{ table.size }}</span>
            </div>
            <div class="spec">
              <span class="spec-label">品牌</span>
              <span class="spec-value">{{ table.brand }}</span>
            </div>
          </div>
          <div class="price-row">
            <div class="price">
              <span class="amount">¥{{ table.price }}</span>
              <span class="unit">/小时</span>
            </div>
            <button v-if="table.available" class="btn-book" @click="openBooking(table)">立即预约</button>
            <button
              v-else-if="isToday"
              class="btn-queue"
              :disabled="boardMap[table.id]?.full"
              @click="openQueueJoin(table)"
            >
              {{ boardMap[table.id]?.full ? '排队已满' : '现场排队' }}
            </button>
            <button v-else class="btn-book" disabled>暂不可用</button>
          </div>
          <div v-if="isToday && boardMap[table.id]?.activeCount" class="queue-meta">
            <template v-if="boardMap[table.id].currentCall">
              <span class="queue-meta-current">
                当前叫号 {{ boardMap[table.id].currentCall.no }}
                <em :class="boardMap[table.id].currentCall.status">{{ boardMap[table.id].currentCall.statusText }}</em>
              </span>
            </template>
            <template v-else>
              <span class="queue-meta-wait">{{ boardMap[table.id].waitingCount }} 桌等待</span>
            </template>
            <span class="queue-meta-eta">预计约 {{ newcomerWait(table.id) }} 分钟</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 现场排队叫号 -->
    <section class="queue-section">
      <div class="queue-header">
        <div class="queue-title">
          <span class="queue-live-dot" :class="{ offline: !queueState.online }"></span>
          <h2>现场排队叫号</h2>
          <span class="queue-live-text">{{ queueState.online ? '实时更新中' : '网络中断' }}</span>
        </div>
        <button class="network-switch" :class="{ online: queueState.online }" @click="toggleNetwork">
          {{ queueState.online ? '📶 网络正常 · 模拟断网' : '📵 已断网 · 恢复网络' }}
        </button>
      </div>

      <div v-if="!queueState.online" class="offline-banner">
        <span>📵 当前网络中断，排队操作已在本机生效，顺序不会丢失；恢复网络后将自动同步。</span>
        <span v-if="queueState.outbox.length" class="offline-count">待同步 {{ queueState.outbox.length }} 条</span>
      </div>

      <!-- 我的排队 -->
      <div v-if="myTicket" class="my-ticket-card" :class="myTicket.status">
        <div class="my-ticket-main">
          <div class="my-ticket-no">{{ myTicket.no }}</div>
          <div class="my-ticket-info">
            <h3>{{ tableName(myTicket.tableId) }}</h3>
            <p>
              <span class="ticket-status-tag" :class="myTicket.statusType">{{ myTicket.statusText }}</span>
              <span v-if="myTicket.pending" class="pending-tag">待同步</span>
              <template v-if="myTicket.status === 'waiting' || myTicket.status === 'missed'">
                <span v-if="myPosition !== null" class="ticket-position">
                  前面还有 <strong>{{ myPosition - 1 }}</strong> 桌 · 您是第 <strong>{{ myPosition }}</strong> 位
                </span>
                <span class="ticket-eta"
                  >预计等待约 <strong>{{ myWaitMinutes }}</strong> 分钟</span
                >
              </template>
              <template v-else-if="myTicket.status === 'called'">
                <span class="ticket-calling"
                  >请在 <strong>{{ callRemaining }}</strong> 秒内到场核验</span
                >
              </template>
              <template v-else-if="myTicket.status === 'arrived'">
                <span class="ticket-arrived">已核验到场，请等待开台</span>
              </template>
              <template v-else-if="myTicket.status === 'serving'">
                <span class="ticket-serving">正在使用中</span>
              </template>
            </p>
          </div>
        </div>
        <div class="my-ticket-actions">
          <button v-if="myTicket.status === 'called'" class="action primary" @click="onCheckIn">我已到场</button>
          <button v-if="myTicket.status === 'missed'" class="action primary" @click="onRestore">恢复排队</button>
          <button
            v-if="['waiting', 'called', 'arrived', 'missed'].includes(myTicket.status)"
            class="action danger"
            @click="openCancelTicket"
          >
            取消排队
          </button>
          <span v-if="myTicket.status === 'serving'" class="hint">完成后请由店员结束本次排队</span>
        </div>
        <p v-if="myTicket.status === 'missed'" class="missed-hint">
          您已过号，恢复后将按原号码 {{ myTicket.no }} 回到原排队位置。
        </p>
      </div>

      <!-- 各球桌叫号看板 -->
      <div class="queue-boards">
        <div v-for="board in boards" :key="board.tableId" class="queue-board">
          <div class="board-head">
            <div class="board-table">
              <span class="board-name">{{ tableName(board.tableId) }}</span>
              <span class="board-badge" :class="board.currentCall ? board.currentCall.status : 'idle'">
                {{
                  board.currentCall
                    ? `叫号 ${board.currentCall.no} · ${board.currentCall.statusText}`
                    : board.waitingCount
                      ? '等待叫号'
                      : '空闲'
                }}
              </span>
            </div>
            <div class="board-stats">
              <span
                >等待 <strong>{{ board.waitingCount }}</strong> 桌</span
              >
              <span
                >预计 <strong>{{ newcomerWait(board.tableId) }}</strong> 分钟</span
              >
            </div>
          </div>

          <div v-if="board.currentCall" class="board-current">
            <div class="current-label">当前号码</div>
            <div class="current-no">{{ board.currentCall.no }}</div>
            <div class="current-party">
              {{ board.currentCall.userName }}
              <em :class="board.currentCall.status">{{ board.currentCall.statusText }}</em>
            </div>
            <div v-if="board.currentCall.status === 'called'" class="current-timer">
              到场核验倒计时 <strong>{{ remainingOf(board.currentCall.id) }}</strong> 秒
            </div>
          </div>

          <div class="board-line">
            <div class="line-label">排队顺序</div>
            <div v-if="board.line.length" class="line-tags">
              <span
                v-for="item in board.line"
                :key="item.id"
                class="line-tag"
                :class="{ mine: item.id === myTicket?.id, missed: item.status === 'missed' }"
              >
                {{ item.no }}
                <small v-if="item.status === 'missed'">过号</small>
                <small v-else-if="item.id === myTicket?.id">我</small>
              </span>
            </div>
            <div v-else class="line-empty">暂无排队</div>
          </div>

          <div class="board-staff">
            <button class="staff-btn" :disabled="!board.canCallNext" @click="onCallNext(board.tableId)">
              叫下一位
            </button>
            <button
              v-if="board.currentCall?.status === 'called'"
              class="staff-btn ghost"
              @click="onMarkMissed(board.currentCall.id)"
            >
              标记过号
            </button>
            <button
              v-if="board.currentCall?.status === 'arrived'"
              class="staff-btn ghost"
              @click="onStartService(board.currentCall.id)"
            >
              确认开台
            </button>
            <button
              v-if="board.currentCall?.status === 'serving'"
              class="staff-btn ghost"
              @click="onCompleteService(board.currentCall.id)"
            >
              完成并释放球桌
            </button>
            <span class="staff-hint">店员操作（演示）</span>
          </div>
        </div>
      </div>
    </section>

    <!-- Booking Modal -->
    <Modal
      v-model="showBookingModal"
      title="预约球桌"
      subtitle="请选择预约时段"
      size="medium"
      confirm-text="确认预约"
      :loading="bookingLoading"
      @confirm="confirmBooking"
    >
      <div v-if="selectedTable" class="booking-form">
        <div class="booking-table-info">
          <div class="table-preview">
            <div class="preview-surface"></div>
          </div>
          <div class="table-details">
            <h4>{{ selectedTable.name }}</h4>
            <p>{{ selectedTable.type }} · {{ selectedTable.brand }}</p>
            <span class="table-price">¥{{ selectedTable.price }}/小时</span>
          </div>
        </div>

        <div class="form-group">
          <label>预约日期</label>
          <div class="date-input">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
            <input v-model="bookingDate" type="date" :min="today" />
          </div>
        </div>

        <div class="form-group">
          <label>选择时段</label>
          <div class="time-slots">
            <button
              v-for="slot in timeSlots"
              :key="slot.id"
              class="time-slot"
              :class="{ active: selectedTimeSlot === slot.id, disabled: !slot.available }"
              :disabled="!slot.available"
              @click="selectedTimeSlot = slot.id"
            >
              <span class="slot-time">{{ slot.time }}</span>
              <span class="slot-status">{{ slot.available ? '可预约' : '已满' }}</span>
            </button>
          </div>
        </div>

        <div class="form-group">
          <label>预约时长</label>
          <div class="duration-selector">
            <button
              v-for="d in durations"
              :key="d"
              class="duration-btn"
              :class="{ active: duration === d }"
              @click="duration = d"
            >
              {{ d }}小时
            </button>
          </div>
        </div>

        <div class="booking-summary">
          <div class="summary-row">
            <span>球桌费用</span>
            <span>¥{{ selectedTable.price }} × {{ duration }}小时</span>
          </div>
          <div class="summary-row total">
            <span>合计</span>
            <span class="total-price">¥{{ selectedTable.price * duration }}</span>
          </div>
        </div>
      </div>
    </Modal>

    <!-- Cancel Queue Modal -->
    <Modal
      v-model="showCancelTicketModal"
      icon="warning"
      icon-type="warning"
      title="确认取消排队"
      subtitle="取消后将释放排队名额，确定要取消吗？"
      size="small"
      confirm-text="确认取消"
      confirm-type="danger"
      :loading="cancelTicketLoading"
      @confirm="confirmCancelTicket"
    />

    <!-- Success Modal -->
    <Modal
      v-model="showSuccessModal"
      icon="🎉"
      icon-type="success"
      title="预约成功"
      :subtitle="successMessage"
      size="small"
      :show-cancel="false"
      confirm-text="我知道了"
      @confirm="showSuccessModal = false"
    >
      <div v-if="bookingResult" class="success-details">
        <div class="detail-item">
          <span class="label">预约编号</span>
          <span class="value">{{ bookingResult.orderNo }}</span>
        </div>
        <div class="detail-item">
          <span class="label">球桌</span>
          <span class="value">{{ bookingResult.tableName }}</span>
        </div>
        <div class="detail-item">
          <span class="label">时间</span>
          <span class="value">{{ bookingResult.date }} {{ bookingResult.time }}</span>
        </div>
      </div>
    </Modal>

    <!-- Toast -->
    <Toast v-model="showToast" :type="toastType" :title="toastTitle" :message="toastMessage" />

    <!-- Login Modal -->
    <LoginModal v-model="showLoginModal" @success="onLoginSuccess" />
  </div>
</template>

<script>
import Modal from '../components/Modal.vue'
import Toast from '../components/Toast.vue'
import LoginModal from '../components/LoginModal.vue'
import { isAuthenticated } from '../utils/auth'
import { taskStore } from '../utils/taskStore'
import { queueStore, queueState } from '../utils/queueStore'

export default {
  name: 'Tables',
  components: { Modal, Toast, LoginModal },
  data() {
    return {
      selectedType: 'all',
      selectedDate: new Date().toISOString().split('T')[0],
      isLoadingTables: false,
      showBookingModal: false,
      showSuccessModal: false,
      bookingLoading: false,
      selectedTable: null,
      bookingDate: new Date().toISOString().split('T')[0],
      selectedTimeSlot: 1,
      duration: 2,
      durations: [1, 2, 3, 4],
      bookingResult: null,
      successMessage: '',
      showToast: false,
      toastType: 'success',
      toastTitle: '',
      toastMessage: '',
      showLoginModal: false,
      pendingTable: null,
      // 排队相关
      queueState,
      queueTick: 0,
      queueTimer: null,
      unsubscribeQueue: [],
      pendingQueueTable: null,
      pendingCancelTicketId: null,
      showCancelTicketModal: false,
      cancelTicketLoading: false,
      hadPendingOps: false,
      tableTypes: [
        { id: 'all', name: '全部', icon: '🎱' },
        { id: 'snooker', name: '斯诺克', icon: '🟢' },
        { id: 'pool', name: '美式九球', icon: '🟡' },
        { id: 'chinese', name: '中式八球', icon: '⚫' }
      ],
      timeSlots: [
        { id: 1, time: '10:00 - 12:00', available: true },
        { id: 2, time: '12:00 - 14:00', available: true },
        { id: 3, time: '14:00 - 16:00', available: true },
        { id: 4, time: '16:00 - 18:00', available: false },
        { id: 5, time: '18:00 - 20:00', available: true },
        { id: 6, time: '20:00 - 22:00', available: true }
      ],
      tables: queueStore.tables.map(table => ({
        ...table,
        available: queueStore.getTableAvailability(table.id, new Date().toISOString().split('T')[0])
      }))
    }
  },
  computed: {
    isToday() {
      return this.selectedDate === this.today
    },
    /** 每桌排队看板（读取响应式 queueState，叫号/过号/同步后自动刷新） */
    boardMap() {
      this.queueTick
      const map = {}
      queueStore.tables.forEach(table => {
        map[table.id] = queueStore.getBoard(table.id)
      })
      return map
    },
    /** 仅展示存在活跃排队或球桌占用中的桌台看板 */
    boards() {
      return queueStore.tables
        .map(table => this.boardMap[table.id])
        .filter(board => board.activeCount > 0 || queueStore.isTableBusy(board.tableId))
    },
    myTicket() {
      this.queueTick
      return queueStore.getMyTicket()
    },
    myPosition() {
      if (!this.myTicket) return null
      return queueStore.getPosition(this.myTicket.id)
    },
    myWaitMinutes() {
      if (!this.myTicket) return 0
      return queueStore.getEstimatedWait(this.myTicket.id) ?? 0
    },
    callRemaining() {
      if (!this.myTicket || this.myTicket.status !== 'called') return 0
      return queueStore.getCallRemainingSeconds(this.myTicket.id)
    },
    filteredTables() {
      // 球桌有效可用状态：当日基础状态与现场排队占用合并，随排队状态实时变化（今日）
      const withAvailability = this.tables.map(table => ({
        ...table,
        available: queueStore.getTableAvailability(table.id, this.selectedDate)
      }))
      if (this.selectedType === 'all') return withAvailability
      return withAvailability.filter(t => t.typeId === this.selectedType)
    },
    today() {
      return new Date().toISOString().split('T')[0]
    }
  },
  watch: {
    selectedDate() {
      this.loadTablesForDate()
    }
  },
  mounted() {
    queueStore.init()
    // 叫号/过号/同步/网络变化时刷新页面与提示
    this.unsubscribeQueue = [
      queueStore.on('called', ticket => {
        this.queueTick++
        if (this.myTicket?.id === ticket.id) {
          this.showNotification('warning', `轮到您了，请立即到场（${ticket.no}）`, '球桌已叫号，请在60秒内到场核验')
        } else {
          this.showNotification('info', '现场叫号', `${this.tableName(ticket.tableId)} 正在呼叫 ${ticket.no}`)
        }
      }),
      queueStore.on('missed', ticket => {
        this.queueTick++
        if (this.myTicket?.id === ticket.id) {
          this.showNotification('error', `您已过号（${ticket.no}）`, '可在排队面板恢复原号码，回到原排队位置')
        }
      }),
      queueStore.on('synced', () => {
        this.queueTick++
        if (this.queueState.outbox.length === 0 && this.hadPendingOps) {
          this.hadPendingOps = false
          this.showNotification('success', '排队信息已同步', '网络恢复，断网期间的排队操作已同步完成')
        }
      }),
      queueStore.on('online', online => {
        this.queueTick++
        if (online) {
          this.hadPendingOps = true
        }
      })
    ]
    // 每秒驱动叫号倒计时显示
    this.queueTimer = setInterval(() => {
      this.queueTick++
    }, 1000)
  },
  beforeUnmount() {
    this.unsubscribeQueue.forEach(fn => fn())
    if (this.queueTimer) clearInterval(this.queueTimer)
  },
  methods: {
    async loadTablesForDate() {
      this.isLoadingTables = true
      // 模拟接口加载延迟
      await new Promise(resolve => setTimeout(resolve, 500))
      // 可用状态由日期与现场排队稳定计算，重复进入/切换日期结果一致
      this.queueTick++
      this.isLoadingTables = false
    },
    tableName(tableId) {
      return queueStore.tables.find(t => t.id === tableId)?.name || ''
    },
    newcomerWait(tableId) {
      return queueStore.getNewcomerWait(tableId)
    },
    remainingOf(ticketId) {
      return queueStore.getCallRemainingSeconds(ticketId)
    },
    async toggleNetwork() {
      await queueStore.setOnline(!this.queueState.online)
      this.queueTick++
    },
    // ---------- 排队操作 ----------
    openQueueJoin(table) {
      if (!isAuthenticated()) {
        this.pendingQueueTable = table
        this.showLoginModal = true
        return
      }
      this.doJoinQueue(table)
    },
    async doJoinQueue(table) {
      const result = await queueStore.joinQueue(table.id)
      this.queueTick++
      if (result.success) {
        const wait = queueStore.getNewcomerWait(table.id)
        const ticket = result.data.ticket
        this.showNotification(
          'success',
          `排队成功（${ticket.no}）`,
          `${table.name}，预计等待约 ${wait} 分钟${result.offline ? '，当前断网，已本机排队待同步' : ''}`
        )
      } else {
        this.handleQueueError(result)
      }
    },
    async onCheckIn() {
      if (!this.myTicket) return
      const result = await queueStore.checkIn(this.myTicket.id)
      this.queueTick++
      if (result.success) {
        this.showNotification('success', '到场核验成功', '店员确认后即可开台')
      } else {
        this.handleQueueError(result)
      }
    },
    async onRestore() {
      if (!this.myTicket) return
      const result = await queueStore.restoreTicket(this.myTicket.id)
      this.queueTick++
      if (result.success) {
        this.showNotification('success', '已恢复排队', `号码 ${result.data.ticket.no} 已回到原排队位置`)
      } else {
        this.handleQueueError(result)
      }
    },
    openCancelTicket() {
      if (!this.myTicket) return
      this.pendingCancelTicketId = this.myTicket.id
      this.showCancelTicketModal = true
    },
    async confirmCancelTicket() {
      if (!this.pendingCancelTicketId) return
      this.cancelTicketLoading = true
      const result = await queueStore.cancelTicket(this.pendingCancelTicketId)
      this.cancelTicketLoading = false
      this.showCancelTicketModal = false
      this.queueTick++
      if (result.success) {
        this.showNotification('success', '已取消排队', '您的排队号码已取消，名额已释放')
      } else {
        this.handleQueueError(result)
      }
      this.pendingCancelTicketId = null
    },
    async onCallNext(tableId) {
      const result = await queueStore.callNext(tableId)
      this.queueTick++
      if (!result.success) {
        this.handleQueueError(result)
      }
    },
    async onMarkMissed(ticketId) {
      const result = await queueStore.markMissed(ticketId)
      this.queueTick++
      if (!result.success) {
        this.handleQueueError(result)
      }
    },
    async onStartService(ticketId) {
      const result = await queueStore.startService(ticketId)
      this.queueTick++
      if (!result.success) {
        this.handleQueueError(result)
      }
    },
    async onCompleteService(ticketId) {
      const result = await queueStore.completeService(ticketId)
      this.queueTick++
      if (result.success) {
        this.showNotification('success', '球桌已释放', '该球桌恢复为可预约状态')
      } else {
        this.handleQueueError(result)
      }
    },
    handleQueueError(result) {
      if (result.code === queueStore.errorCode.AUTH_REQUIRED) {
        this.showLoginModal = true
        return
      }
      this.showNotification('error', '操作未成功', result.error || '请稍后重试')
    },
    openBooking(table) {
      // 检查是否已登录
      if (!isAuthenticated()) {
        this.pendingTable = table
        this.showLoginModal = true
        return
      }
      this.selectedTable = table
      this.bookingDate = this.selectedDate
      this.selectedTimeSlot = 1
      this.duration = 2
      this.showBookingModal = true
    },
    /**
     * 登录成功回调
     */
    onLoginSuccess() {
      this.showLoginModal = false
      if (this.pendingTable) {
        this.openBooking(this.pendingTable)
        this.pendingTable = null
      } else if (this.pendingQueueTable) {
        this.doJoinQueue(this.pendingQueueTable)
        this.pendingQueueTable = null
      }
    },
    async confirmBooking() {
      this.bookingLoading = true

      // Simulate API call
      await new Promise(resolve => setTimeout(resolve, 1500))

      const slot = this.timeSlots.find(s => s.id === this.selectedTimeSlot)
      const orderNo = 'BK' + Date.now().toString().slice(-8)
      this.bookingResult = {
        orderNo,
        tableName: this.selectedTable.name,
        date: this.bookingDate,
        time: slot.time
      }
      this.successMessage = `${this.bookingDate} ${slot.time}`

      // 添加到任务中心
      const bookingInfo = {
        orderNo,
        date: this.bookingDate,
        time: slot.time,
        duration: this.duration
      }
      taskStore.addBookingTask(this.selectedTable, bookingInfo)

      this.bookingLoading = false
      this.showBookingModal = false
      this.showSuccessModal = true

      this.showNotification('info', '已添加到任务中心', `您可以在任务中心查看并管理此预约`)
    },
    showNotification(type, title, message) {
      this.toastType = type
      this.toastTitle = title
      this.toastMessage = message
      this.showToast = true
    }
  }
}
</script>

<style scoped>
.tables-page {
  max-width: 1400px;
  margin: 0 auto;
  padding: 0 3rem 4rem;
}

.page-header {
  text-align: center;
  padding: 2rem 0 4rem;
}

.page-tag {
  display: inline-block;
  background: rgba(0, 217, 165, 0.1);
  color: var(--primary);
  padding: 0.5rem 1rem;
  border-radius: 50px;
  font-size: 0.85rem;
  font-weight: 500;
  margin-bottom: 1rem;
}

.page-header h1 {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 3rem;
  font-weight: 700;
  margin-bottom: 0.75rem;
}

.page-header p {
  color: var(--text-secondary);
  font-size: 1.1rem;
}

/* Filter Section */
.filter-section {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2.5rem;
  flex-wrap: wrap;
  gap: 1rem;
}

.filter-tabs {
  display: flex;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 0.4rem;
  gap: 0.25rem;
}

.filter-tabs button {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: transparent;
  border: none;
  padding: 0.75rem 1.25rem;
  color: var(--text-secondary);
  font-size: 0.9rem;
  font-weight: 500;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.3s;
}

.filter-tabs button:hover {
  color: var(--text-primary);
}

.filter-tabs button.active {
  background: var(--primary);
  color: var(--bg-dark);
}

.tab-icon {
  font-size: 1rem;
}

.date-picker {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 0.75rem 1rem;
}

.date-picker svg {
  width: 20px;
  height: 20px;
  color: var(--text-secondary);
}

.date-picker input {
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-size: 0.9rem;
  outline: none;
}

.date-picker input::-webkit-calendar-picker-indicator {
  filter: invert(1);
  cursor: pointer;
}

/* Tables Grid */
.tables-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 1.5rem;
  position: relative;
  min-height: 200px;
}

.tables-grid.loading {
  pointer-events: none;
}

.tables-grid.loading .table-card {
  opacity: 0.3;
  filter: blur(2px);
}

.loading-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  z-index: 10;
  color: var(--text-secondary);
  font-size: 0.9rem;
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--border);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.table-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 20px;
  overflow: hidden;
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.table-card.available:hover {
  transform: translateY(-6px);
  border-color: var(--primary);
  box-shadow: var(--shadow-glow);
}

.table-card.unavailable {
  opacity: 0.6;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.25rem 1.5rem;
}

.table-type-badge {
  background: rgba(255, 255, 255, 0.05);
  padding: 0.4rem 0.8rem;
  border-radius: 8px;
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.status-indicator.online .status-dot {
  background: var(--primary);
  box-shadow: 0 0 10px var(--primary);
}

.status-indicator.online {
  color: var(--primary);
}

.status-indicator.offline .status-dot {
  background: #ff6b6b;
}

.status-indicator.offline {
  color: #ff6b6b;
}

/* Table Visual */
.table-visual {
  padding: 1rem 1.5rem;
}

.table-3d {
  perspective: 500px;
}

.table-surface {
  position: relative;
  height: 100px;
  background: linear-gradient(135deg, #1b5e20 0%, #2e7d32 100%);
  border-radius: 8px;
  border: 6px solid #5d4037;
  box-shadow:
    inset 0 0 20px rgba(0, 0, 0, 0.3),
    0 10px 30px rgba(0, 0, 0, 0.3);
  transform: rotateX(10deg);
}

.pocket {
  position: absolute;
  width: 12px;
  height: 12px;
  background: #1a1a1a;
  border-radius: 50%;
}

.pocket.tl {
  top: 4px;
  left: 4px;
}
.pocket.tr {
  top: 4px;
  right: 4px;
}
.pocket.ml {
  top: 50%;
  left: 4px;
  transform: translateY(-50%);
}
.pocket.mr {
  top: 50%;
  right: 4px;
  transform: translateY(-50%);
}
.pocket.bl {
  bottom: 4px;
  left: 4px;
}
.pocket.br {
  bottom: 4px;
  right: 4px;
}

/* Card Content */
.card-content {
  padding: 1.25rem 1.5rem 1.5rem;
}

.card-content h3 {
  font-size: 1.25rem;
  font-weight: 600;
  margin-bottom: 1rem;
}

.table-specs {
  display: flex;
  gap: 2rem;
  margin-bottom: 1.25rem;
}

.spec {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.spec-label {
  font-size: 0.75rem;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.spec-value {
  font-size: 0.9rem;
  color: var(--text-secondary);
}

.price-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 1.25rem;
  border-top: 1px solid var(--border);
}

.price .amount {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--primary);
}

.price .unit {
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.btn-book {
  background: var(--gradient-1);
  color: var(--bg-dark);
  border: none;
  padding: 0.75rem 1.5rem;
  font-size: 0.9rem;
  font-weight: 600;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.3s;
}

.btn-book:hover:not(:disabled) {
  transform: scale(1.02);
  box-shadow: 0 5px 20px var(--primary-glow);
}

.btn-book:disabled {
  background: var(--bg-card-hover);
  color: var(--text-muted);
  cursor: not-allowed;
}

/* Booking Form */
.booking-form {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.booking-table-info {
  display: flex;
  gap: 1rem;
  padding: 1rem;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 14px;
}

.table-preview {
  width: 80px;
  height: 50px;
  flex-shrink: 0;
}

.preview-surface {
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, #1b5e20 0%, #2e7d32 100%);
  border-radius: 6px;
  border: 4px solid #5d4037;
}

.table-details h4 {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 0.25rem;
}

.table-details p {
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin-bottom: 0.25rem;
}

.table-price {
  font-size: 0.9rem;
  color: var(--primary);
  font-weight: 600;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.form-group label {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text-secondary);
}

.date-input {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.75rem 1rem;
}

.date-input svg {
  width: 18px;
  height: 18px;
  color: var(--text-secondary);
}

.date-input input {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-size: 0.9rem;
  outline: none;
}

.date-input input::-webkit-calendar-picker-indicator {
  filter: invert(1);
  cursor: pointer;
}

.time-slots {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.5rem;
}

.time-slot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  padding: 0.75rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s;
}

.time-slot:hover:not(.disabled) {
  border-color: var(--primary);
}

.time-slot.active {
  background: rgba(0, 217, 165, 0.1);
  border-color: var(--primary);
}

.time-slot.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.slot-time {
  font-size: 0.9rem;
  font-weight: 500;
}

.slot-status {
  font-size: 0.7rem;
  color: var(--text-muted);
}

.time-slot.active .slot-status {
  color: var(--primary);
}

.duration-selector {
  display: flex;
  gap: 0.5rem;
}

.duration-btn {
  flex: 1;
  padding: 0.75rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text-primary);
  font-size: 0.9rem;
  cursor: pointer;
  transition: all 0.2s;
}

.duration-btn:hover {
  border-color: var(--primary);
}

.duration-btn.active {
  background: rgba(0, 217, 165, 0.1);
  border-color: var(--primary);
  color: var(--primary);
}

.booking-summary {
  padding: 1rem;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 12px;
}

.summary-row {
  display: flex;
  justify-content: space-between;
  font-size: 0.9rem;
  color: var(--text-secondary);
  padding: 0.5rem 0;
}

.summary-row.total {
  border-top: 1px solid var(--border);
  margin-top: 0.5rem;
  padding-top: 1rem;
  font-weight: 600;
  color: var(--text-primary);
}

.total-price {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 1.25rem;
  color: var(--primary);
}

/* Success Details */
.success-details {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 12px;
  text-align: left;
}

.detail-item {
  display: flex;
  justify-content: space-between;
  font-size: 0.9rem;
}

.detail-item .label {
  color: var(--text-secondary);
}

.detail-item .value {
  font-weight: 500;
}

/* Queue entry on table card */
.btn-queue {
  background: rgba(0, 217, 165, 0.12);
  color: var(--primary);
  border: 1px solid rgba(0, 217, 165, 0.4);
  padding: 0.75rem 1.5rem;
  font-size: 0.9rem;
  font-weight: 600;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.3s;
}

.btn-queue:hover:not(:disabled) {
  background: rgba(0, 217, 165, 0.2);
  transform: scale(1.02);
}

.btn-queue:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.queue-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 0.85rem;
  padding-top: 0.85rem;
  border-top: 1px dashed var(--border);
  font-size: 0.78rem;
  color: var(--text-secondary);
}

.queue-meta-current em,
.board-current .current-party em {
  font-style: normal;
  padding: 0.1rem 0.5rem;
  border-radius: 20px;
  font-size: 0.7rem;
  margin-left: 0.4rem;
}

.queue-meta-current em.called,
.board-current .current-party em.called {
  background: rgba(255, 193, 7, 0.15);
  color: #ffc107;
}

.queue-meta-current em.arrived,
.board-current .current-party em.arrived {
  background: rgba(0, 217, 165, 0.15);
  color: var(--primary);
}

.queue-meta-current em.serving,
.board-current .current-party em.serving {
  background: rgba(0, 217, 165, 0.15);
  color: var(--primary);
}

/* Live Queue Section */
.queue-section {
  margin-top: 3.5rem;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 24px;
  padding: 2rem;
}

.queue-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.queue-title {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.queue-title h2 {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 1.6rem;
  font-weight: 700;
}

.queue-live-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--primary);
  box-shadow: 0 0 0 0 rgba(0, 217, 165, 0.6);
  animation: pulse 1.6s infinite;
}

.queue-live-dot.offline {
  background: #ff6b6b;
  animation: none;
}

@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(0, 217, 165, 0.5);
  }
  70% {
    box-shadow: 0 0 0 10px rgba(0, 217, 165, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(0, 217, 165, 0);
  }
}

.queue-live-text {
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.network-switch {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  padding: 0.55rem 1rem;
  border-radius: 20px;
  font-size: 0.82rem;
  cursor: pointer;
  transition: all 0.3s;
}

.network-switch:hover {
  border-color: var(--primary);
  color: var(--text-primary);
}

.network-switch.online {
  border-color: rgba(0, 217, 165, 0.3);
}

.offline-banner {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  background: rgba(255, 107, 107, 0.08);
  border: 1px solid rgba(255, 107, 107, 0.3);
  color: #ffb3b3;
  border-radius: 14px;
  padding: 0.9rem 1.2rem;
  font-size: 0.85rem;
  margin-bottom: 1.5rem;
}

.offline-count {
  background: rgba(255, 107, 107, 0.2);
  color: #ff6b6b;
  padding: 0.2rem 0.7rem;
  border-radius: 20px;
  font-size: 0.78rem;
  font-weight: 600;
}

/* My ticket */
.my-ticket-card {
  background: linear-gradient(135deg, rgba(0, 217, 165, 0.08) 0%, rgba(0, 180, 216, 0.05) 100%);
  border: 1px solid rgba(0, 217, 165, 0.25);
  border-radius: 18px;
  padding: 1.5rem;
  margin-bottom: 1.5rem;
}

.my-ticket-card.missed {
  background: rgba(255, 193, 7, 0.06);
  border-color: rgba(255, 193, 7, 0.3);
}

.my-ticket-card.called {
  background: rgba(255, 193, 7, 0.08);
  border-color: rgba(255, 193, 7, 0.4);
}

.my-ticket-main {
  display: flex;
  gap: 1.25rem;
  align-items: center;
}

.my-ticket-no {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 2rem;
  font-weight: 700;
  color: var(--primary);
  background: rgba(0, 217, 165, 0.1);
  border-radius: 14px;
  padding: 0.75rem 1.25rem;
  white-space: nowrap;
}

.my-ticket-card.missed .my-ticket-no,
.my-ticket-card.called .my-ticket-no {
  color: #ffc107;
  background: rgba(255, 193, 7, 0.12);
}

.my-ticket-info h3 {
  font-size: 1.1rem;
  margin-bottom: 0.4rem;
}

.my-ticket-info p {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
  font-size: 0.88rem;
  color: var(--text-secondary);
}

.ticket-status-tag {
  padding: 0.2rem 0.7rem;
  border-radius: 20px;
  font-size: 0.75rem;
  font-weight: 600;
}

.ticket-status-tag.info {
  background: rgba(79, 172, 254, 0.15);
  color: #4facfe;
}
.ticket-status-tag.warning {
  background: rgba(255, 193, 7, 0.15);
  color: #ffc107;
}
.ticket-status-tag.primary {
  background: rgba(0, 217, 165, 0.15);
  color: var(--primary);
}
.ticket-status-tag.danger {
  background: rgba(255, 107, 107, 0.15);
  color: #ff6b6b;
}
.ticket-status-tag.muted {
  background: rgba(138, 138, 154, 0.15);
  color: var(--text-secondary);
}
.ticket-status-tag.success {
  background: rgba(0, 217, 165, 0.15);
  color: var(--primary);
}

.pending-tag {
  background: rgba(255, 107, 107, 0.15);
  color: #ff6b6b;
  padding: 0.2rem 0.7rem;
  border-radius: 20px;
  font-size: 0.72rem;
  font-weight: 600;
}

.ticket-position strong,
.ticket-eta strong {
  color: var(--text-primary);
}

.ticket-calling strong {
  color: #ffc107;
  font-size: 1.05rem;
}

.my-ticket-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 1.2rem;
  flex-wrap: wrap;
}

.my-ticket-actions .action {
  padding: 0.6rem 1.4rem;
  border-radius: 10px;
  font-size: 0.88rem;
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition: all 0.3s;
}

.my-ticket-actions .action.primary {
  background: var(--gradient-1);
  color: var(--bg-dark);
}

.my-ticket-actions .action.primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 14px var(--primary-glow);
}

.my-ticket-actions .action.danger {
  background: rgba(255, 107, 107, 0.1);
  border: 1px solid rgba(255, 107, 107, 0.3);
  color: #ff6b6b;
}

.my-ticket-actions .action.danger:hover {
  background: rgba(255, 107, 107, 0.2);
}

.my-ticket-actions .hint {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.missed-hint {
  margin-top: 0.85rem;
  font-size: 0.8rem;
  color: #ffc107;
}

/* Queue boards */
.queue-boards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 1.25rem;
}

.queue-board {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 1.4rem;
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}

.board-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.75rem;
}

.board-table {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.board-name {
  font-size: 1.05rem;
  font-weight: 600;
}

.board-badge {
  font-size: 0.72rem;
  padding: 0.2rem 0.65rem;
  border-radius: 20px;
  width: fit-content;
  font-weight: 600;
}

.board-badge.idle {
  background: rgba(138, 138, 154, 0.15);
  color: var(--text-secondary);
}
.board-badge.called {
  background: rgba(255, 193, 7, 0.15);
  color: #ffc107;
}
.board-badge.arrived,
.board-badge.serving {
  background: rgba(0, 217, 165, 0.15);
  color: var(--primary);
}

.board-stats {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.78rem;
  color: var(--text-secondary);
  text-align: right;
}

.board-stats strong {
  color: var(--text-primary);
}

.board-current {
  background: rgba(255, 193, 7, 0.06);
  border: 1px solid rgba(255, 193, 7, 0.2);
  border-radius: 14px;
  padding: 1rem 1.2rem;
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}

.board-current .current-label {
  font-size: 0.75rem;
  color: var(--text-secondary);
  width: 100%;
}

.board-current .current-no {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 1.9rem;
  font-weight: 700;
  color: #ffc107;
  line-height: 1;
}

.board-current .current-party {
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.board-current .current-timer {
  width: 100%;
  font-size: 0.78rem;
  color: var(--text-secondary);
}

.board-current .current-timer strong {
  color: #ffc107;
}

.board-line {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.line-label {
  font-size: 0.75rem;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.line-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.line-tag {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  background: rgba(79, 172, 254, 0.08);
  border: 1px solid rgba(79, 172, 254, 0.25);
  color: #4facfe;
  border-radius: 10px;
  padding: 0.4rem 0.7rem;
  font-size: 0.82rem;
  font-weight: 600;
}

.line-tag small {
  font-size: 0.68rem;
  font-weight: 400;
  opacity: 0.85;
}

.line-tag.mine {
  background: rgba(0, 217, 165, 0.14);
  border-color: var(--primary);
  color: var(--primary);
}

.line-tag.missed {
  background: rgba(255, 107, 107, 0.08);
  border-color: rgba(255, 107, 107, 0.3);
  color: #ff8585;
  text-decoration: line-through;
  text-decoration-color: rgba(255, 107, 107, 0.6);
}

.line-empty {
  font-size: 0.82rem;
  color: var(--text-muted);
}

.board-staff {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
}

.staff-btn {
  background: var(--gradient-1);
  color: var(--bg-dark);
  border: none;
  padding: 0.55rem 1.1rem;
  border-radius: 10px;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s;
}

.staff-btn:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px var(--primary-glow);
}

.staff-btn:disabled {
  background: var(--bg-card-hover);
  color: var(--text-muted);
  cursor: not-allowed;
}

.staff-btn.ghost {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
  color: var(--text-primary);
}

.staff-btn.ghost:hover:not(:disabled) {
  border-color: var(--primary);
  box-shadow: none;
}

.staff-hint {
  font-size: 0.72rem;
  color: var(--text-muted);
  margin-left: auto;
}

@media (max-width: 768px) {
  .tables-page {
    padding: 0 1.5rem 3rem;
  }

  .page-header h1 {
    font-size: 2rem;
  }

  .filter-section {
    flex-direction: column;
    align-items: stretch;
  }

  .filter-tabs {
    overflow-x: auto;
  }

  .tables-grid {
    grid-template-columns: 1fr;
  }

  .time-slots {
    grid-template-columns: 1fr;
  }

  .queue-section {
    padding: 1.25rem;
  }

  .queue-title h2 {
    font-size: 1.25rem;
  }

  .my-ticket-main {
    flex-direction: column;
    align-items: flex-start;
  }

  .queue-boards {
    grid-template-columns: 1fr;
  }
}
</style>
