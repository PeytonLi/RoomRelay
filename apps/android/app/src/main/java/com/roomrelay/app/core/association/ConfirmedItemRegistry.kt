package com.roomrelay.app.core.association

import com.roomrelay.app.core.Vec3
import com.roomrelay.app.core.distanceMeters
import com.roomrelay.app.core.inference.RoomRelayCategory

data class ConfirmedItem(
    val id: Long,
    val category: RoomRelayCategory,
    val position: Vec3,
)

sealed interface MergeDecision {
    /** Exactly one same-category item within 0.25 m and nothing else within 0.5 m. */
    data class SameAsExisting(val itemId: Long) : MergeDecision

    /** Same-category items in the 0.25-0.5 m band or multiple within 0.5 m. */
    data class Ask(val candidateIds: List<Long>) : MergeDecision

    data object NewItem : MergeDecision
}

/**
 * Confirmed items with same-category-only merge suggestions. The decision
 * never auto-merges: SameAsExisting still requires user confirmation in the
 * UI, and different categories never merge.
 */
class ConfirmedItemRegistry {
    private val items = mutableListOf<ConfirmedItem>()
    private var nextId = 1L

    fun items(): List<ConfirmedItem> = items.toList()

    fun get(id: Long): ConfirmedItem? = items.firstOrNull { it.id == id }

    fun add(category: RoomRelayCategory, position: Vec3): ConfirmedItem {
        val item = ConfirmedItem(nextId++, category, position)
        items += item
        return item
    }

    fun remove(id: Long): Boolean = items.removeAll { it.id == id }

    fun decide(category: RoomRelayCategory, position: Vec3): MergeDecision {
        val sameCategory = items.filter { it.category == category }
        val within025 = sameCategory.filter { distanceMeters(it.position, position) <= 0.25 }
        val within05 = sameCategory.filter { distanceMeters(it.position, position) <= 0.5 }
        return when {
            within025.size == 1 && within05.size == 1 ->
                MergeDecision.SameAsExisting(within025[0].id)
            within05.isNotEmpty() -> MergeDecision.Ask(within05.map { it.id })
            else -> MergeDecision.NewItem
        }
    }
}
