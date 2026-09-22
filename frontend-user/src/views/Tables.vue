<template>
  <div class="tables-page">
    <header class="page-header">
      <div class="header-content">
        <span class="page-tag">在线预约</span>
        <h1>球桌预约</h1>
        <p>选择您喜欢的球桌类型，开始您的台球时光</p>
      </div>
    </header>

    <!-- 网络状态条 -->
    <Transition name="network-bar">
      <div v-if="!isOnline" class="network-offline-bar">
        <span class="offline-dot"></span>
        <span class="offline-text">
          网络已中断，排队操作将在本地生效
          <template v-if="pendingSyncCount > 0">，{{ pendingSyncCount }} 条更新待同步</template>
        </span>
        <button class="btn-retry" :disabled="reconnecting" @click="retryConnection">
          {{ reconnecting ? '重连中...' : '重新连接' }}
        </button>
      </div>
    </Transition>

    <!-- 我的现场排队 -->
    <section v-if="myQueues.length" class="my-queue-section">
      <div class="my-queue-header">
        <h2><span class="my-queue-icon">📟</span> 我的现场排队</h2>
        <span class="my-queue-tip">叫号后请留意状态，过号可一键恢复顺序</span>
      </div>
      <div class="my-queue-list">
        <div
          v-for="ticket in myQueues"
          :key="ticket.id"
          class="my-queue-card"
          :class="`st-${ticket.status}`"
        >
          <div class="mq-no">{{ ticket.ticketNo }}</div>
          <div class="mq-info">
            <span class="mq-table">{{ tableNameMap[ticket.tableId] }}</span>
            <span class="mq-status" :class="`tag-${ticket.statusType}`">{{ ticket.statusText }}</span>
          </div>
          <div class="mq-meta">
            <template v-if="ticket.status === 'waiting'">
              <span>前方 {{ Math.max(0, ticket.position - 1) }} 位</span>
              <span>预计等待约 {{ formatWait(ticket.estimatedWaitMinutes) }}</span>
            </template>
            <template v-else-if="ticket.status === 'called'">
              <span class="mq-blink">🔔 正在叫号，请尽快到场</span>
              <span>剩余 {{ formatCountdown(ticket.calledRemainMs) }}</span>
            </template>
            <template v-else-if="ticket.status === 'arrived'">
              <span>已核验到场，等待引导就坐</span>
            </template>
            <template v-else-if="ticket.status === 'seated'">
              <span>正在使用球桌</span>
            </template>
          </div>
          <div class="mq-actions">
            <button class="mq-btn link" @click="openQueue(ticket.tableId)">查看队列</button>
            <button
              v-if="ticket.status === 'called'"
              class="mq-btn primary"
              :disabled="busyTicketId === ticket.id"
              @click="handleArrive(ticket)"
            >
              {{ busyTicketId === ticket.id ? '确认中...' : '我已到场' }}
            </button>
            <button
              v-if="['waiting', 'called', 'arrived'].includes(ticket.status)"
              class="mq-btn danger"
              :disabled="busyTicketId === ticket.id"
              @click="handleCancel(ticket)"
            >
              取消排队
            </button>
          </div>
        </div>
      </div>
    </section>

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
        <button
          class="network-toggle"
          :class="{ offline: !isOnline }"
          @click="toggleNetwork"
        >
          <span class="net-dot"></span>
          {{ isOnline ? '网络正常' : '模拟断网' }}
        </button>
        <div class="date-picker">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="4" width="18" height="18" rx="2"/>
            <path d="M16 2v4M8 2v4M3 10h18"/>
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
        v-for="table in displayTables"
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

        <!-- 现场排队状态条（当天占用桌） -->
        <div v-if="isTodaySelected" class="queue-mini-bar" @click="openQueue(table.id)">
          <template v-if="queueViewMap[table.id] && queueViewMap[table.id].count > 0">
            <div class="mini-calling">
              <span class="mini-label">当前叫号</span>
              <span v-if="queueViewMap[table.id].calling" class="mini-no">
                {{ queueViewMap[table.id].calling.ticketNo }}
              </span>
              <span v-else class="mini-no none">等待中</span>
            </div>
            <div class="mini-count">
              <span class="mini-num">{{ queueViewMap[table.id].count }}</span>
              <span class="mini-label">人排队</span>
            </div>
            <span class="mini-arrow">现场排队 ›</span>
          </template>
          <template v-else>
            <span class="mini-label">暂无现场排队，可现场取号</span>
            <span class="mini-arrow">现场排队 ›</span>
          </template>
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
            <!-- 可预约：保留原预约入口 -->
            <button
              v-if="table.available"
              class="btn-book"
              @click="openBooking(table)"
            >
              立即预约
            </button>
            <!-- 当天占用：现场排队取号 -->
            <template v-else-if="isTodaySelected">
              <button
                v-if="myTicketMap[table.id]"
                class="btn-queue joined"
                @click="openQueue(table.id)"
              >
                {{ myTicketMap[table.id].ticketNo }} · {{ myTicketMap[table.id].statusText }}
              </button>
              <button
                v-else-if="queueFullMap[table.id]"
                class="btn-queue full"
                disabled
              >
                排队已满
              </button>
              <button
                v-else
                class="btn-queue"
                :disabled="joiningTableId === table.id"
                @click="joinQueue(table)"
              >
                {{ joiningTableId === table.id ? '取号中...' : '现场排队' }}
              </button>
            </template>
            <button v-else class="btn-book" disabled>暂不可用</button>
          </div>
        </div>
      </div>
    </div>

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
              <rect x="3" y="4" width="18" height="18" rx="2"/>
              <path d="M16 2v4M8 2v4M3 10h18"/>
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

    <!-- 现场排队叫号 Modal -->
    <Modal
      v-model="showQueueModal"
      title="现场排队叫号"
      :subtitle="queueModalSubtitle"
      size="large"
      :show-footer="false"
    >
      <div class="queue-panel">
        <!-- 网络状态 -->
        <div v-if="!isOnline" class="queue-offline-banner">
          <span>📶 当前网络不可用，状态已保存在本机；恢复后将自动同步（待同步 {{ pendingSyncCount }} 条）</span>
          <button class="banner-retry" :disabled="reconnecting" @click="retryConnection">
            {{ reconnecting ? '重连中...' : '重试' }}
          </button>
        </div>

        <template v-if="queueTable">
          <!-- 叫号大屏区 -->
          <div class="call-stage" :class="{ ringing: currentCalling }">
            <div class="call-stage-label">当前叫号</div>
            <div v-if="currentCalling" class="call-stage-no">{{ currentCalling.ticketNo }}</div>
            <div v-else class="call-stage-no empty">暂无叫号</div>
            <div class="call-stage-desc">
              <template v-if="currentCalling">
                {{ currentCalling.userName }} 请前往 {{ queueTable.name }}
                <span v-if="currentCalling.isSelf" class="self-flag">· 该您了！</span>
              </template>
              <template v-else>等待下一位叫号</template>
            </div>
          </div>

          <!-- 我的票 -->
          <div class="my-ticket-block">
            <template v-if="activeTicket">
              <div class="my-ticket-card" :class="`st-${activeTicket.status}`">
                <div class="mt-head">
                  <span class="mt-no">{{ activeTicket.ticketNo }}</span>
                  <span class="mt-status" :class="`tag-${activeTicket.statusType}`">
                    {{ activeTicket.statusText }}
                  </span>
                  <span v-if="activeTicket.pendingSync" class="mt-sync">待同步</span>
                </div>
                <div class="mt-body">
                  <template v-if="activeTicket.status === 'waiting'">
                    <div class="mt-stat">
                      <span class="mt-stat-num">{{ activeTicket.position }}</span>
                      <span class="mt-stat-label">当前顺序</span>
                    </div>
                    <div class="mt-stat">
                      <span class="mt-stat-num">{{ Math.max(0, activeTicket.position - 1) }}</span>
                      <span class="mt-stat-label">前方人数</span>
                    </div>
                    <div class="mt-stat">
                      <span class="mt-stat-num wait">{{ formatWait(activeTicket.estimatedWaitMinutes) }}</span>
                      <span class="mt-stat-label">预计等待</span>
                    </div>
                  </template>
                  <template v-else-if="activeTicket.status === 'called'">
                    <div class="mt-stat wide">
                      <span class="mt-stat-num blink">🔔 {{ formatCountdown(activeTicket.calledRemainMs) }}</span>
                      <span class="mt-stat-label">正在叫号，请在时限内到场，超时将过号</span>
                    </div>
                  </template>
                  <template v-else-if="activeTicket.status === 'arrived'">
                    <div class="mt-stat wide">
                      <span class="mt-stat-num wait">✅ 已到场</span>
                      <span class="mt-stat-label">工作人员核验后将引导就坐</span>
                    </div>
                  </template>
                  <template v-else-if="activeTicket.status === 'seated'">
                    <div class="mt-stat wide">
                      <span class="mt-stat-num">🏓 使用中</span>
                      <span class="mt-stat-label">{{ queueTable.name }} 正在为您服务</span>
                    </div>
                  </template>
                </div>
                <div class="mt-actions">
                  <button
                    v-if="activeTicket.status === 'called'"
                    class="mt-btn primary"
                    :disabled="busyTicketId === activeTicket.id"
                    @click="handleArrive(activeTicket)"
                  >
                    {{ busyTicketId === activeTicket.id ? '确认中...' : '我已到场' }}
                  </button>
                  <button
                    v-if="['waiting', 'called', 'arrived'].includes(activeTicket.status)"
                    class="mt-btn danger"
                    :disabled="busyTicketId === activeTicket.id"
                    @click="handleCancel(activeTicket)"
                  >
                    取消排队
                  </button>
                </div>
              </div>
            </template>

            <!-- 过号票 -->
            <template v-else-if="missedTicket">
              <div class="my-ticket-card st-missed">
                <div class="mt-head">
                  <span class="mt-no">{{ missedTicket.ticketNo }}</span>
                  <span class="mt-status tag-danger">已过号</span>
                </div>
                <p class="missed-tip">您的号已过，恢复后将回到队首优先叫号，原顺序不丢失。</p>
                <div class="mt-actions">
                  <button
                    class="mt-btn primary"
                    :disabled="busyTicketId === missedTicket.id"
                    @click="handleRestore(missedTicket)"
                  >
                    {{ busyTicketId === missedTicket.id ? '恢复中...' : '恢复排队' }}
                  </button>
                </div>
              </div>
            </template>

            <!-- 取号 -->
            <template v-else>
              <div class="join-block">
                <div class="join-info">
                  <div class="join-info-row">
                    <span>当前等待</span>
                    <strong>{{ queueView ? queueView.waiting.length : 0 }} 位</strong>
                  </div>
                  <div class="join-info-row">
                    <span>叫号中</span>
                    <strong>{{ queueView ? queueView.calledCount : 0 }} 位</strong>
                  </div>
                  <div class="join-info-row">
                    <span>排队名额</span>
                    <strong>{{ queueView ? queueView.count : 0 }}/{{ maxQueueSize }}</strong>
                  </div>
                </div>
                <button
                  class="mt-btn primary join-btn"
                  :disabled="queueFull || joiningTableId === queueTable.id"
                  @click="joinQueue(queueTable)"
                >
                  <template v-if="joiningTableId === queueTable.id">取号中...</template>
                  <template v-else-if="queueFull">排队已满，请稍后再试</template>
                  <template v-else>立即取号排队</template>
                </button>
              </div>
            </template>
          </div>

          <!-- 队列明细 -->
          <div class="queue-list-block">
            <div class="queue-list-title">
              <span>排队顺序</span>
              <span class="queue-list-count">共 {{ queueView ? queueView.queueList.length : 0 }} 位</span>
            </div>
            <div v-if="queueView && queueView.queueList.length" class="queue-list">
              <div
                v-for="(item, idx) in queueView.queueList"
                :key="item.id"
                class="queue-row"
                :class="{
                  self: item.isSelf,
                  calling: item.status === 'called',
                  arrived: item.status === 'arrived'
                }"
              >
                <span class="qr-pos">{{ idx + 1 }}</span>
                <span class="qr-no">{{ item.ticketNo }}</span>
                <span class="qr-name">{{ item.userName }}{{ item.isSelf ? '（我）' : '' }}</span>
                <span v-if="item.status === 'waiting' && item.restoredAt" class="qr-badge restore">已恢复</span>
                <span class="qr-status" :class="`tag-${item.statusType}`">{{ item.statusText }}</span>
                <span class="qr-wait">
                  <template v-if="item.status === 'waiting'">约{{ formatWait(item.estimatedWaitMinutes) }}</template>
                  <template v-else-if="item.status === 'called'">剩余 {{ formatCountdown(item.calledRemainMs) }}</template>
                </span>
              </div>
            </div>
            <div v-else class="queue-empty">当前暂无排队，取号后将在此显示顺序</div>

            <div v-if="queueView && queueView.seated.length" class="seated-row">
              <span class="tag tag-primary">使用中</span>
              <span v-for="t in queueView.seated" :key="t.id" class="seated-no">
                {{ t.ticketNo }}{{ t.isSelf ? '（我）' : '' }}
              </span>
            </div>
          </div>
        </template>
      </div>
    </Modal>

    <!-- Toast -->
    <Toast v-model="showToast" :type="toastType" :title="toastTitle" :message="toastMessage" />

    <!-- Login Modal -->
    <LoginModal v-model="showLoginModal" @success="onLoginSuccess" @login-success="onLoginSuccess" />
  </div>
</template>

<script>
import Modal from '../components/Modal.vue'
import Toast from '../components/Toast.vue'
import LoginModal from '../components/LoginModal.vue'
import { isAuthenticated, getCurrentUser } from '../utils/auth'
import { taskStore } from '../utils/taskStore'
import { queueStore, queueState } from '../utils/queueStore'

const SIMULATION_INTERVAL = 3000

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
      // 登录后的待执行动作：booking / queue
      pendingAction: null,
      // 现场排队状态
      showQueueModal: false,
      queueTableId: null,
      joiningTableId: null,
      busyTicketId: null,
      reconnecting: false,
      // 用于驱动预计等待/倒计时的秒级刷新
      nowTick: Date.now(),
      simulationTimer: null,
      maxQueueSize: 10,
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
      tables: [
        { id: 1, name: '1号球桌', type: '斯诺克', typeId: 'snooker', price: 80, available: true, size: '12尺', brand: '星牌' },
        { id: 2, name: '2号球桌', type: '斯诺克', typeId: 'snooker', price: 80, available: false, size: '12尺', brand: '星牌' },
        { id: 3, name: '3号球桌', type: '美式九球', typeId: 'pool', price: 60, available: true, size: '9尺', brand: 'Brunswick' },
        { id: 4, name: '4号球桌', type: '美式九球', typeId: 'pool', price: 60, available: true, size: '9尺', brand: 'Brunswick' },
        { id: 5, name: '5号球桌', type: '中式八球', typeId: 'chinese', price: 50, available: false, size: '9尺', brand: '乔氏' },
        { id: 6, name: '6号球桌', type: '中式八球', typeId: 'chinese', price: 50, available: true, size: '9尺', brand: '乔氏' }
      ]
    }
  },
  computed: {
    filteredTables() {
      if (this.selectedType === 'all') return this.tables
      return this.tables.filter(t => t.typeId === this.selectedType)
    },
    today() {
      return new Date().toISOString().split('T')[0]
    },
    isTodaySelected() {
      return this.selectedDate === this.today
    },
    /**
     * 页面展示的球桌列表。
     * 当天：存在现场排队（等待/叫号/到场/使用中）的球桌保持占用，
     * 队列全部终结（完成/取消）后立即恢复可预约；
     * 其他日期沿用日期加载得到的可用状态。
     * 价格、类型筛选逻辑保持不变。
     */
    displayTables() {
      this.nowTick
      return this.filteredTables.map(table => {
        if (!this.isTodaySelected) return table
        const occupied = queueStore.isTableBusy(table.id) || queueStore.getQueueCount(table.id) > 0
        return {
          ...table,
          available: occupied ? false : table.available
        }
      })
    },
    tableNameMap() {
      const map = {}
      this.tables.forEach(t => {
        map[t.id] = t.name
      })
      return map
    },
    isOnline() {
      return queueState.online
    },
    pendingSyncCount() {
      return queueState.outbox.length
    },
    /** 各桌排队视图（响应式） */
    queueViewMap() {
      this.nowTick
      const map = {}
      this.tables.forEach(t => {
        map[t.id] = queueStore.getTableView(t.id)
      })
      return map
    },
    /** 我在各桌的活跃票 */
    myTicketMap() {
      this.nowTick
      const map = {}
      this.tables.forEach(t => {
        map[t.id] = queueStore.getMyTicket(t.id)
      })
      return map
    },
    queueFullMap() {
      const map = {}
      this.tables.forEach(t => {
        map[t.id] = queueStore.isQueueFull(t.id)
      })
      return map
    },
    /** 跨球桌的我的现场排队汇总 */
    myQueues() {
      this.nowTick
      return queueStore.getMyActiveTickets()
    },
    queueTable() {
      return this.tables.find(t => t.id === this.queueTableId) || null
    },
    queueView() {
      if (!this.queueTableId) return null
      return this.queueViewMap[this.queueTableId] || null
    },
    queueModalSubtitle() {
      if (!this.queueTable) return ''
      return `${this.queueTable.name} · ¥${this.queueTable.price}/小时 · ${this.queueTable.type}`
    },
    activeTicket() {
      if (!this.queueTableId) return null
      return queueStore.getMyTicket(this.queueTableId)
    },
    missedTicket() {
      if (!this.queueTableId) return null
      return queueStore.getMissedTicket(this.queueTableId)
    },
    currentCalling() {
      if (!this.queueTableId || !this.queueView) return null
      return this.queueView.calling
    },
    queueFull() {
      return this.queueView ? this.queueView.full : false
    }
  },
  watch: {
    selectedDate() {
      this.loadTablesForDate()
    }
  },
  created() {
    queueStore.init()
    queueStore.seedDemoData(this.tables, { busyTableId: 2, waitingTableId: 5, waitingCount: 3 })
  },
  mounted() {
    // 秒级刷新预计等待与叫号倒计时
    this.simulationTimer = setInterval(() => {
      this.nowTick = Date.now()
      this.tickSimulation()
    }, SIMULATION_INTERVAL)
  },
  beforeUnmount() {
    if (this.simulationTimer) {
      clearInterval(this.simulationTimer)
      this.simulationTimer = null
    }
  },
  methods: {
    async loadTablesForDate() {
      this.isLoadingTables = true
      // 模拟API请求延迟
      await new Promise(resolve => setTimeout(resolve, 800))
      // 模拟不同日期的球桌可用状态变化
      this.tables = this.tables.map(table => ({
        ...table,
        available: Math.random() > 0.3
      }))
      this.isLoadingTables = false
    },
    /** 推进现场叫号模拟，并处理叫号/过号提醒 */
    tickSimulation() {
      if (!this.isOnline) return
      const events = queueStore.advanceSimulation()
      events.forEach(evt => {
        if (evt.type === 'called' && evt.isSelf) {
          this.showNotification('warning', '轮到您了', `号 ${evt.ticketNo} 正在叫号，请尽快到场`)
        } else if (evt.type === 'missed' && evt.isSelf) {
          this.showNotification('error', '您已过号', `号 ${evt.ticketNo} 过号，可在排队面板恢复顺序`)
        }
      })
    },
    openBooking(table) {
      // 检查是否已登录
      if (!isAuthenticated()) {
        this.pendingTable = table
        this.pendingAction = 'booking'
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
     * 打开现场排队面板
     */
    openQueue(tableId) {
      this.queueTableId = tableId
      this.showQueueModal = true
    },
    /**
     * 现场取号排队：登录校验、重复排队/满员/断网处理
     */
    async joinQueue(table) {
      if (!isAuthenticated()) {
        this.pendingTable = table
        this.pendingAction = 'queue'
        this.showLoginModal = true
        return
      }

      // 重复排队：直接打开已有排队，不再取号
      const existing = queueStore.getMyTicket(table.id)
      if (existing) {
        this.queueTableId = table.id
        this.showQueueModal = true
        this.showNotification('info', '您已在排队中', `排队号 ${existing.ticketNo}，请勿重复取号`)
        return
      }

      if (queueStore.isQueueFull(table.id)) {
        this.showNotification('error', '排队已满', `${table.name} 现场排队已满，请稍后再试`)
        return
      }

      const user = getCurrentUser()
      this.joiningTableId = table.id
      try {
        const ticket = await queueStore.joinQueue(table.id, {
          userId: 'me',
          userName: user?.name || '我',
          graceMs: 30 * 1000
        })
        this.queueTableId = table.id
        this.showQueueModal = true
        if (this.isOnline) {
          this.showNotification('success', '取号成功', `您的排队号为 ${ticket.ticketNo}`)
        } else {
          this.showNotification('warning', '已离线取号', `排队号 ${ticket.ticketNo} 已在本地生效，联网后自动同步`)
        }
      } catch (e) {
        this.handleQueueError(e, table)
      } finally {
        this.joiningTableId = null
      }
    },
    /**
     * 我已到场：已叫号 -> 已到场
     */
    async handleArrive(ticket) {
      this.busyTicketId = ticket.id
      try {
        await queueStore.markArrived(ticket.id)
        this.showNotification('success', '到场成功', `${ticket.ticketNo} 已核验，等待引导就坐`)
      } catch (e) {
        this.showNotification('error', '操作失败', e.message)
      } finally {
        this.busyTicketId = null
      }
    },
    /**
     * 过号恢复：回到队首可叫位置
     */
    async handleRestore(ticket) {
      this.busyTicketId = ticket.id
      try {
        const restored = await queueStore.restoreTicket(ticket.id)
        this.showNotification('success', '已恢复排队', `${ticket.ticketNo} 回到队首位置，当前第 ${restored.position} 位`)
      } catch (e) {
        this.showNotification('error', '恢复失败', e.message)
      } finally {
        this.busyTicketId = null
      }
    },
    /**
     * 取消排队：后续人员顺序自动前移
     */
    async handleCancel(ticket) {
      this.busyTicketId = ticket.id
      try {
        await queueStore.cancelTicket(ticket.id)
        this.showNotification('info', '已取消排队', `${ticket.ticketNo} 已取消`)
      } catch (e) {
        this.showNotification('error', '操作失败', e.message)
      } finally {
        this.busyTicketId = null
      }
    },
    handleQueueError(error, table) {
      if (error.code === 'ALREADY_JOINED') {
        this.queueTableId = table.id
        this.showQueueModal = true
        this.showNotification('info', '您已在排队中', '请勿重复取号')
      } else if (error.code === 'QUEUE_FULL') {
        this.showNotification('error', '排队已满', `${table.name} 现场排队已满，请稍后再试`)
      } else {
        this.showNotification('error', '取号失败', error.message || '请稍后重试')
      }
    },
    /**
     * 模拟网络恢复：重新联网并补同步发件箱
     */
    async retryConnection() {
      if (this.reconnecting) return
      this.reconnecting = true
      await new Promise(resolve => setTimeout(resolve, 600))
      try {
        const result = await queueStore.setOnline(true)
        if (result.remaining === 0) {
          this.showNotification('success', '网络已恢复', result.flushed > 0 ? `已同步 ${result.flushed} 条排队更新` : '排队状态已更新')
        } else {
          this.showNotification('warning', '同步未完成', `仍有 ${result.remaining} 条更新待同步`)
        }
      } finally {
        this.reconnecting = false
      }
    },
    /** 演示：手动切换断网/联网（状态条中的入口也可扩展） */
    async toggleNetwork() {
      if (this.isOnline) {
        await queueStore.setOnline(false)
        this.showNotification('warning', '已模拟断网', '排队操作将先在本地生效')
      } else {
        await this.retryConnection()
      }
    },
    formatWait(minutes) {
      if (minutes === null || minutes === undefined) return '—'
      if (minutes <= 0) return '即将叫号'
      return `约${minutes}分钟`
    },
    formatCountdown(ms) {
      if (ms === null || ms === undefined) return '—'
      const total = Math.max(0, Math.ceil(ms / 1000))
      const m = Math.floor(total / 60)
      const s = total % 60
      return `${m}:${String(s).padStart(2, '0')}`
    },
    /**
     * 登录成功回调：继续登录前被拦截的预约或排队动作
     */
    onLoginSuccess() {
      this.showLoginModal = false
      const pending = this.pendingTable
      const action = this.pendingAction
      this.pendingTable = null
      this.pendingAction = null
      if (!pending) return
      if (action === 'queue') {
        this.joinQueue(pending)
      } else {
        this.openBooking(pending)
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
  to { transform: rotate(360deg); }
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
  background: linear-gradient(135deg, #1B5E20 0%, #2E7D32 100%);
  border-radius: 8px;
  border: 6px solid #5D4037;
  box-shadow: 
    inset 0 0 20px rgba(0,0,0,0.3),
    0 10px 30px rgba(0,0,0,0.3);
  transform: rotateX(10deg);
}

.pocket {
  position: absolute;
  width: 12px;
  height: 12px;
  background: #1a1a1a;
  border-radius: 50%;
}

.pocket.tl { top: 4px; left: 4px; }
.pocket.tr { top: 4px; right: 4px; }
.pocket.ml { top: 50%; left: 4px; transform: translateY(-50%); }
.pocket.mr { top: 50%; right: 4px; transform: translateY(-50%); }
.pocket.bl { bottom: 4px; left: 4px; }
.pocket.br { bottom: 4px; right: 4px; }

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
  background: linear-gradient(135deg, #1B5E20 0%, #2E7D32 100%);
  border-radius: 6px;
  border: 4px solid #5D4037;
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

/* ========== 现场排队叫号样式 ========== */

.filter-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.network-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 0.75rem 1rem;
  color: var(--text-secondary);
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.2s;
}

.network-toggle:hover {
  border-color: var(--primary);
  color: var(--text-primary);
}

.net-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--primary);
  box-shadow: 0 0 8px var(--primary);
}

.network-toggle.offline {
  border-color: rgba(255, 107, 107, 0.4);
  color: #ff6b6b;
}

.network-toggle.offline .net-dot {
  background: #ff6b6b;
  box-shadow: 0 0 8px #ff6b6b;
}

/* 网络中断状态条 */
.network-offline-bar {
  display: flex;
  align-items: center;
  gap: 1rem;
  background: rgba(255, 107, 107, 0.1);
  border: 1px solid rgba(255, 107, 107, 0.35);
  border-radius: 12px;
  padding: 0.75rem 1.25rem;
  margin-bottom: 1.5rem;
  font-size: 0.88rem;
  color: #ffb3b3;
}

.offline-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ff6b6b;
  flex-shrink: 0;
  animation: blink 1s infinite;
}

.offline-text {
  flex: 1;
}

.btn-retry,
.banner-retry {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: var(--text-primary);
  border-radius: 8px;
  padding: 0.4rem 1rem;
  font-size: 0.82rem;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-retry:hover,
.banner-retry:hover {
  background: rgba(255, 255, 255, 0.15);
}

.btn-retry:disabled,
.banner-retry:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@keyframes blink {
  50% { opacity: 0.3; }
}

.network-bar-enter-active,
.network-bar-leave-active {
  transition: all 0.3s;
}

.network-bar-enter-from,
.network-bar-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* 我的现场排队 */
.my-queue-section {
  margin-bottom: 2rem;
}

.my-queue-header {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  margin-bottom: 1rem;
}

.my-queue-header h2 {
  font-size: 1.15rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.my-queue-icon {
  font-size: 1.2rem;
}

.my-queue-tip {
  font-size: 0.82rem;
  color: var(--text-muted);
}

.my-queue-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 1rem;
}

.my-queue-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-left: 3px solid var(--primary);
  border-radius: 14px;
  padding: 1rem 1.25rem;
}

.my-queue-card.st-called {
  border-left-color: #ffc107;
  box-shadow: 0 0 30px rgba(255, 193, 7, 0.08);
}

.my-queue-card.st-arrived {
  border-left-color: var(--primary);
}

.my-queue-card.st-seated {
  border-left-color: #4facfe;
}

.mq-no {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 1.6rem;
  font-weight: 700;
  color: var(--primary);
  letter-spacing: 1px;
}

.st-called .mq-no { color: #ffc107; }
.st-arrived .mq-no { color: var(--primary); }
.st-seated .mq-no { color: #4facfe; }

.mq-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0.25rem 0 0.5rem;
}

.mq-table {
  font-size: 0.95rem;
  font-weight: 500;
}

.mq-meta {
  display: flex;
  gap: 1rem;
  font-size: 0.82rem;
  color: var(--text-secondary);
}

.mq-blink {
  color: #ffc107;
  font-weight: 600;
  animation: blink 1.2s infinite;
}

.mq-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

.mq-btn {
  border-radius: 8px;
  padding: 0.45rem 0.9rem;
  font-size: 0.82rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  border: 1px solid var(--border);
}

.mq-btn.link {
  background: transparent;
  color: var(--text-secondary);
}

.mq-btn.link:hover {
  color: var(--primary);
  border-color: var(--primary);
}

.mq-btn.primary {
  background: var(--gradient-1);
  border: none;
  color: var(--bg-dark);
  font-weight: 600;
}

.mq-btn.danger {
  background: transparent;
  color: #ff6b6b;
  border-color: rgba(255, 107, 107, 0.4);
}

.mq-btn.danger:hover {
  background: rgba(255, 107, 107, 0.1);
}

.mq-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 状态标签 */
.mq-status,
.qr-status,
.mt-status,
.tag {
  font-size: 0.72rem;
  padding: 0.15rem 0.55rem;
  border-radius: 20px;
  font-weight: 500;
  white-space: nowrap;
}

.tag-info { background: rgba(79, 172, 254, 0.15); color: #4facfe; }
.tag-warning { background: rgba(255, 193, 7, 0.15); color: #ffc107; }
.tag-success { background: rgba(0, 217, 165, 0.15); color: var(--primary); }
.tag-primary { background: rgba(0, 217, 165, 0.15); color: var(--primary); }
.tag-danger { background: rgba(255, 107, 107, 0.15); color: #ff6b6b; }
.tag-default { background: rgba(255, 255, 255, 0.06); color: var(--text-muted); }

/* 球桌卡内排队状态条 */
.queue-mini-bar {
  display: flex;
  align-items: center;
  gap: 1.25rem;
  margin: 0 1.5rem;
  padding: 0.75rem 1rem;
  background: rgba(0, 217, 165, 0.05);
  border: 1px solid rgba(0, 217, 165, 0.18);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.queue-mini-bar:hover {
  background: rgba(0, 217, 165, 0.1);
  border-color: rgba(0, 217, 165, 0.4);
}

.mini-calling,
.mini-count {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.mini-label {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.mini-no {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 1rem;
  font-weight: 700;
  color: #ffc107;
  letter-spacing: 0.5px;
}

.mini-no.none {
  color: var(--text-muted);
  font-weight: 500;
}

.mini-num {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 1rem;
  font-weight: 700;
  color: var(--primary);
}

.mini-arrow {
  margin-left: auto;
  font-size: 0.78rem;
  color: var(--primary);
  font-weight: 500;
}

/* 现场排队按钮 */
.btn-queue {
  background: rgba(0, 217, 165, 0.12);
  color: var(--primary);
  border: 1px solid rgba(0, 217, 165, 0.4);
  padding: 0.75rem 1.25rem;
  font-size: 0.9rem;
  font-weight: 600;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.3s;
  max-width: 150px;
}

.btn-queue:hover:not(:disabled) {
  background: rgba(0, 217, 165, 0.2);
  box-shadow: 0 5px 20px var(--primary-glow);
}

.btn-queue.joined {
  background: rgba(255, 193, 7, 0.1);
  border-color: rgba(255, 193, 7, 0.4);
  color: #ffc107;
}

.btn-queue.full,
.btn-queue:disabled {
  background: var(--bg-card-hover);
  border-color: var(--border);
  color: var(--text-muted);
  cursor: not-allowed;
  box-shadow: none;
}

/* ========== 排队面板 Modal ========== */

.queue-panel {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.queue-offline-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  background: rgba(255, 107, 107, 0.08);
  border: 1px solid rgba(255, 107, 107, 0.3);
  border-radius: 12px;
  padding: 0.75rem 1rem;
  font-size: 0.83rem;
  color: #ffb3b3;
}

.call-stage {
  position: relative;
  text-align: center;
  padding: 1.5rem 1rem;
  border-radius: 16px;
  background: linear-gradient(135deg, rgba(0, 217, 165, 0.08) 0%, rgba(0, 180, 216, 0.08) 100%);
  border: 1px solid rgba(0, 217, 165, 0.2);
  overflow: hidden;
}

.call-stage.ringing {
  border-color: rgba(255, 193, 7, 0.5);
  background: linear-gradient(135deg, rgba(255, 193, 7, 0.08) 0%, rgba(255, 150, 0, 0.06) 100%);
}

.call-stage-label {
  font-size: 0.8rem;
  color: var(--text-secondary);
  letter-spacing: 2px;
  margin-bottom: 0.5rem;
}

.call-stage-no {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 3rem;
  font-weight: 700;
  color: #ffc107;
  letter-spacing: 4px;
  line-height: 1.1;
}

.call-stage-no.empty {
  color: var(--text-muted);
  font-size: 1.8rem;
  letter-spacing: 2px;
}

.call-stage-desc {
  font-size: 0.88rem;
  color: var(--text-secondary);
  margin-top: 0.35rem;
}

.self-flag {
  color: var(--primary);
  font-weight: 700;
}

/* 我的票 */
.my-ticket-card {
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 1.1rem 1.25rem;
  background: rgba(255, 255, 255, 0.02);
}

.my-ticket-card.st-called {
  border-color: rgba(255, 193, 7, 0.45);
  box-shadow: 0 0 30px rgba(255, 193, 7, 0.08);
}

.my-ticket-card.st-arrived {
  border-color: rgba(0, 217, 165, 0.4);
}

.my-ticket-card.st-seated {
  border-color: rgba(79, 172, 254, 0.4);
}

.my-ticket-card.st-missed {
  border-color: rgba(255, 107, 107, 0.4);
  background: rgba(255, 107, 107, 0.04);
}

.mt-head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.mt-no {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--primary);
  letter-spacing: 1px;
}

.st-called .mt-no { color: #ffc107; }
.st-missed .mt-no { color: #ff6b6b; }
.st-seated .mt-no { color: #4facfe; }

.mt-sync {
  margin-left: auto;
  font-size: 0.72rem;
  color: #ffc107;
  background: rgba(255, 193, 7, 0.12);
  padding: 0.15rem 0.55rem;
  border-radius: 20px;
}

.mt-body {
  display: flex;
  gap: 2rem;
  padding: 0.75rem 0;
}

.mt-stat {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.mt-stat.wide {
  flex: 1;
}

.mt-stat-num {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 1.6rem;
  font-weight: 700;
}

.mt-stat-num.wait {
  color: var(--primary);
  font-size: 1.2rem;
}

.mt-stat-num.blink {
  color: #ffc107;
  animation: blink 1s infinite;
}

.mt-stat-label {
  font-size: 0.78rem;
  color: var(--text-muted);
}

.mt-actions {
  display: flex;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.mt-btn {
  flex: 1;
  padding: 0.8rem 1rem;
  border-radius: 10px;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  border: 1px solid var(--border);
}

.mt-btn.primary {
  background: var(--gradient-1);
  border: none;
  color: var(--bg-dark);
}

.mt-btn.danger {
  background: transparent;
  color: #ff6b6b;
  border-color: rgba(255, 107, 107, 0.4);
  flex: 0 0 140px;
}

.mt-btn.danger:hover {
  background: rgba(255, 107, 107, 0.1);
}

.mt-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.missed-tip {
  font-size: 0.85rem;
  color: var(--text-secondary);
  margin-bottom: 0.75rem;
}

/* 取号区 */
.join-block {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.join-info {
  display: flex;
  justify-content: space-around;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 12px;
  padding: 1rem;
}

.join-info-row {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.82rem;
  color: var(--text-muted);
}

.join-info-row strong {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 1.3rem;
  color: var(--text-primary);
}

.join-btn {
  width: 100%;
}

/* 队列明细 */
.queue-list-block {
  border: 1px solid var(--border);
  border-radius: 16px;
  overflow: hidden;
}

.queue-list-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.9rem 1.25rem;
  font-size: 0.9rem;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.02);
}

.queue-list-count {
  font-size: 0.78rem;
  color: var(--text-muted);
  font-weight: 400;
}

.queue-list {
  max-height: 260px;
  overflow-y: auto;
}

.queue-row {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 0.7rem 1.25rem;
  border-bottom: 1px solid var(--border);
  font-size: 0.86rem;
}

.queue-row:last-child {
  border-bottom: none;
}

.queue-row.self {
  background: rgba(0, 217, 165, 0.06);
}

.queue-row.calling {
  background: rgba(255, 193, 7, 0.06);
}

.qr-pos {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.06);
  font-size: 0.75rem;
  color: var(--text-muted);
  flex-shrink: 0;
}

.queue-row.calling .qr-pos,
.queue-row.arrived .qr-pos {
  background: rgba(255, 193, 7, 0.2);
  color: #ffc107;
}

.qr-no {
  font-family: 'Space Grotesk', sans-serif;
  font-weight: 700;
  color: var(--text-primary);
  min-width: 52px;
  letter-spacing: 0.5px;
}

.qr-name {
  color: var(--text-secondary);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qr-badge.restore {
  font-size: 0.68rem;
  background: rgba(102, 126, 234, 0.15);
  color: #8fa1ff;
  padding: 0.1rem 0.5rem;
  border-radius: 20px;
}

.qr-wait {
  font-size: 0.76rem;
  color: var(--text-muted);
  min-width: 64px;
  text-align: right;
}

.queue-empty {
  padding: 2rem 1rem;
  text-align: center;
  color: var(--text-muted);
  font-size: 0.85rem;
}

.seated-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.8rem 1.25rem;
  border-top: 1px solid var(--border);
  font-size: 0.85rem;
  flex-wrap: wrap;
}

.seated-no {
  font-family: 'Space Grotesk', sans-serif;
  font-weight: 600;
  color: #4facfe;
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

  .filter-right {
    width: 100%;
    justify-content: space-between;
  }

  .my-queue-list {
    grid-template-columns: 1fr;
  }

  .call-stage-no {
    font-size: 2.4rem;
  }

  .mt-body {
    gap: 1.25rem;
  }

  .qr-name {
    display: none;
  }
}
</style>
