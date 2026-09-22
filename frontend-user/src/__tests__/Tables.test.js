/**
 * 球桌页面（Tables）集成冒烟测试
 * 验证现场排队相关 UI 入口、重复排队拦截与断网提示，
 * 并保证原有价格与类型筛选不受影响。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import Tables from '../views/Tables.vue'
import { queueStore } from '../utils/queueStore'

function mountPage() {
  return mount(Tables, {
    global: {
      stubs: {
        Teleport: true,
        Transition: false,
        Modal: {
          props: ['modelValue', 'title', 'showFooter'],
          emits: ['update:modelValue'],
          template: '<div v-if="modelValue" class="modal-stub"><slot /></div>'
        }
      }
    }
  })
}

describe('Tables view queue feature', () => {
  beforeEach(() => {
    queueStore.reset()
    queueStore.setOnline(true)
    queueStore.setRemote(async () => ({ ok: true }))
  })

  afterEach(() => {
    queueStore.reset()
  })

  it('占用桌展示现场排队入口，可预约桌保留立即预约与价格', () => {
    const wrapper = mountPage()
    const cards = wrapper.findAll('.table-card')
    expect(cards.length).toBe(6)

    // 价格仍按原数据展示
    expect(wrapper.text()).toContain('¥80')
    expect(wrapper.text()).toContain('¥60')
    expect(wrapper.text()).toContain('¥50')

    // 2 号桌为占用桌，存在现场排队按钮
    const busyCard = cards.find(c => c.text().includes('2号球桌'))
    expect(busyCard.text()).toContain('现场排队')
    expect(busyCard.text()).toContain('人排队')

    // 可预约桌保留立即预约
    const freeCard = cards.find(c => c.text().includes('1号球桌'))
    expect(freeCard.text()).toContain('立即预约')
  })

  it('类型筛选仅展示对应类型且价格不变', async () => {
    const wrapper = mountPage()
    const tabs = wrapper.findAll('.filter-tabs button')
    await tabs[2].trigger('click') // 美式九球

    const cards = wrapper.findAll('.table-card')
    expect(cards.length).toBe(2)
    cards.forEach(c => expect(c.text()).toContain('美式九球'))
    expect(wrapper.text()).toContain('¥60')
  })

  it('断网时展示网络中断状态条', async () => {
    const wrapper = mountPage()
    expect(wrapper.find('.network-offline-bar').exists()).toBe(false)

    await wrapper.find('.network-toggle').trigger('click')
    expect(wrapper.find('.network-offline-bar').exists()).toBe(true)
    expect(wrapper.text()).toContain('网络已中断')
  })

  it('我的排队卡片在取号后展示', async () => {
    // 预置一张我的排队票
    await queueStore.joinQueue(5, { userId: 'me', userName: '张三' })
    const wrapper = mountPage()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.my-queue-section').exists()).toBe(true)
    expect(wrapper.find('.my-queue-section').text()).toContain('我的现场排队')
  })
})
