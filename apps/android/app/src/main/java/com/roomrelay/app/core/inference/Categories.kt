package com.roomrelay.app.core.inference

/**
 * COCO label map embedded in efficientdet_lite0.tflite (90 slots: 80 real
 * labels plus "???" placeholders). Index order matches the model metadata.
 */
val COCO_LABELS: List<String> = listOf(
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train",
    "truck", "boat", "traffic light", "fire hydrant", "???", "stop sign",
    "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
    "elephant", "bear", "zebra", "giraffe", "???", "backpack", "umbrella",
    "???", "???", "handbag", "tie", "suitcase", "frisbee", "skis",
    "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
    "skateboard", "surfboard", "tennis racket", "bottle", "???",
    "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
    "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut",
    "cake", "chair", "couch", "potted plant", "bed", "???", "dining table",
    "???", "???", "toilet", "???", "tv", "laptop", "mouse", "remote",
    "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "???", "book", "clock", "vase", "scissors",
    "teddy bear", "hair drier", "toothbrush",
)

enum class RoomRelayCategory {
    CHAIR,
    SOFA,
    BED,
    TABLE,
    BENCH,
    TV,
    POTTED_PLANT,
    REFRIGERATOR,
    MICROWAVE,
    OVEN,
    CLOCK,
    VASE,
    DESK,
    SHELF,
    WARDROBE,
    DRESSER,
    LAMP,
    NIGHTSTAND,
    OTHER,
}

/**
 * The only COCO labels that may become room candidates. Furniture types the
 * model cannot see are entered manually and are never produced by detection.
 */
val COCO_TO_CATEGORY: Map<String, RoomRelayCategory> = mapOf(
    "chair" to RoomRelayCategory.CHAIR,
    "couch" to RoomRelayCategory.SOFA,
    "bed" to RoomRelayCategory.BED,
    "dining table" to RoomRelayCategory.TABLE,
    "bench" to RoomRelayCategory.BENCH,
    "tv" to RoomRelayCategory.TV,
    "potted plant" to RoomRelayCategory.POTTED_PLANT,
    "refrigerator" to RoomRelayCategory.REFRIGERATOR,
    "microwave" to RoomRelayCategory.MICROWAVE,
    "oven" to RoomRelayCategory.OVEN,
    "clock" to RoomRelayCategory.CLOCK,
    "vase" to RoomRelayCategory.VASE,
)

val MODEL_DETECTABLE_CATEGORIES: Set<RoomRelayCategory> =
    COCO_TO_CATEGORY.values.toSet()

val MANUAL_ONLY_CATEGORIES: Set<RoomRelayCategory> =
    RoomRelayCategory.entries.toSet() - MODEL_DETECTABLE_CATEGORIES

fun categoryFromCocoLabel(cocoLabel: String): RoomRelayCategory? =
    COCO_TO_CATEGORY[cocoLabel]
