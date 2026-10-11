package com.roomrelay.app.core.association

import com.roomrelay.app.core.Vec3
import com.roomrelay.app.core.inference.RoomRelayCategory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConfirmedItemRegistryTest {

    @Test
    fun `same item within 0-25m`() {
        val registry = ConfirmedItemRegistry()
        val item = registry.add(RoomRelayCategory.CHAIR, Vec3(0.0, 0.0, 0.0))
        val decision = registry.decide(RoomRelayCategory.CHAIR, Vec3(0.2, 0.0, 0.0))
        assertEquals(MergeDecision.SameAsExisting(item.id), decision)
    }

    @Test
    fun `ask in 0-25 to 0-5 band`() {
        val registry = ConfirmedItemRegistry()
        val item = registry.add(RoomRelayCategory.CHAIR, Vec3(0.0, 0.0, 0.0))
        val decision = registry.decide(RoomRelayCategory.CHAIR, Vec3(0.3, 0.0, 0.0))
        assertEquals(MergeDecision.Ask(listOf(item.id)), decision)
    }

    @Test
    fun `ask when two candidates within 0-5`() {
        val registry = ConfirmedItemRegistry()
        val a = registry.add(RoomRelayCategory.CHAIR, Vec3(0.0, 0.0, 0.0))
        val b = registry.add(RoomRelayCategory.CHAIR, Vec3(0.2, 0.0, 0.0))
        val decision = registry.decide(RoomRelayCategory.CHAIR, Vec3(0.15, 0.0, 0.0))
        assertTrue(decision is MergeDecision.Ask)
        assertEquals(setOf(a.id, b.id), (decision as MergeDecision.Ask).candidateIds.toSet())
    }

    @Test
    fun `new item beyond 0-5`() {
        val registry = ConfirmedItemRegistry()
        registry.add(RoomRelayCategory.CHAIR, Vec3(0.0, 0.0, 0.0))
        assertEquals(
            MergeDecision.NewItem,
            registry.decide(RoomRelayCategory.CHAIR, Vec3(0.6, 0.0, 0.0)),
        )
    }

    @Test
    fun `different category never same`() {
        val registry = ConfirmedItemRegistry()
        registry.add(RoomRelayCategory.CHAIR, Vec3(0.0, 0.0, 0.0))
        assertEquals(
            MergeDecision.NewItem,
            registry.decide(RoomRelayCategory.SOFA, Vec3(0.05, 0.0, 0.0)),
        )
    }
}
