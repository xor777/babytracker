plugins {
    id("com.android.application") version "8.7.3" apply false
    // 2.0.x — пара к R8 из AGP 8.7.x: на более свежем Kotlin D8 сыплет
    // «error parsing kotlin metadata» на каждый класс stdlib.
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
