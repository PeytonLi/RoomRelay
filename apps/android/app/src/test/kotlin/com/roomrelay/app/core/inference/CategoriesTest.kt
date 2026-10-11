package com.roomrelay.app.core.inference

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CategoriesTest {

    @Test
    fun `every mapped key is a real COCO label`() {
        COCO_TO_CATEGORY.keys.forEach { key ->
            assertTrue("not in COCO labels: $key", COCO_LABELS.contains(key))
        }
    }

    @Test
    fun `manual-only categories are unreachable from any label`() {
        COCO_LABELS.forEach { label ->
            val category = categoryFromCocoLabel(label)
            assertTrue(
                "$label mapped to manual-only $category",
                category !in MANUAL_ONLY_CATEGORIES,
            )
        }
    }

    @Test
    fun `unmapped label returns null`() {
        assertNull(categoryFromCocoLabel("person"))
        assertNull(categoryFromCocoLabel("cup"))
        assertNull(categoryFromCocoLabel("???"))
        assertNull(categoryFromCocoLabel("skateboard"))
    }

    @Test
    fun `model detectable set matches map values`() {
        assertEquals(MODEL_DETECTABLE_CATEGORIES, COCO_TO_CATEGORY.values.toSet())
        assertTrue(
            MODEL_DETECTABLE_CATEGORIES.none { it in MANUAL_ONLY_CATEGORIES },
        )
    }
}
