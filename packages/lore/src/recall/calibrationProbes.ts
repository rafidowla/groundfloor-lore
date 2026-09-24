/**
 * calibrationProbes.ts — D1 (calibrated relevance + abstention).
 *
 * A FIXED, versioned bank of coherent, plausible natural-language questions
 * that are deliberately off-topic for any software/knowledge-management
 * workspace this codebase serves — cooking, gardening, astronomy, etc. Run
 * through the SAME retrieval path a real query would take (retrieve()'s
 * vector-leg seed search), their top similarity scores form a per-workspace
 * "nothing relevant" null distribution: calibration.ts fits a robust
 * median/IQR to them and converts a real query's own top similarity into a
 * z-score against that distribution.
 *
 * Deliberately NOT single keywords or gibberish — a workspace's embedding
 * space still clusters loosely by "is this coherent English text at all",
 * and single-word/gibberish probes would measure that instead of "is this
 * ABOUT something this workspace has never stored". Held-out gibberish
 * queries (a separate, non-overlapping set) are what the harness uses to
 * verify abstention actually fires — see
 * scripts/diagnostics/recall-eval/gibberish-heldout.json.
 *
 * `PROBE_SET_VERSION` is part of the calibration cache key (calibration.ts).
 * Bump it whenever this list's CONTENT changes (add/remove/reword probes) —
 * a stale-keyed cache entry fit against a since-changed probe set would
 * silently misreport its own basis.
 *
 * License: original work for groundfloor-lore.
 */

export const PROBE_SET_VERSION = 'v1';

/** 128 fixed off-topic probes across 16 non-software domains (8 each). */
export const CALIBRATION_PROBES: readonly string[] = [
    // Cooking
    'What is the ideal internal temperature for a medium-rare steak?',
    'How long should you proof sourdough starter before baking?',
    'What is the difference between braising and stewing?',
    'Why does searing meat before roasting improve the flavor?',
    'What is the best way to prevent a hollandaise sauce from breaking?',
    'How do you properly temper chocolate for dipping?',
    'What is the purpose of resting meat after cooking?',
    'How much salt should you add when brining a turkey?',

    // Gardening
    'When is the best time of year to prune rose bushes?',
    'How often should tomato plants be watered in the summer?',
    'What causes yellowing leaves on a houseplant?',
    'Which vegetables should be planted together as companion plants?',
    'How deep should you plant tulip bulbs in the fall?',
    'What is the best way to compost kitchen scraps at home?',
    'How do you treat powdery mildew on squash plants?',
    'What soil pH is ideal for growing blueberries?',

    // Astronomy
    'Why does the Moon appear larger near the horizon?',
    'What causes the rings of Saturn to be so bright?',
    'How far away is the nearest star to our solar system?',
    'What is the difference between a meteor and a meteorite?',
    'Why do stars twinkle but planets do not?',
    'How do astronomers measure the distance to distant galaxies?',
    'What causes a total solar eclipse to occur?',
    'Why is Mars often called the Red Planet?',

    // History
    'What were the main causes of the fall of the Roman Empire?',
    'When did the printing press first spread across Europe?',
    'Who led the expedition that first circumnavigated the globe?',
    'What triggered the start of the French Revolution?',
    'How did the Silk Road influence trade between Asia and Europe?',
    'What was the significance of the Magna Carta?',
    'When did the ancient library of Alexandria burn down?',
    'What led to the construction of the Great Wall of China?',

    // Geography
    'What is the longest river in South America?',
    'Why is the Dead Sea so much saltier than the ocean?',
    'What causes the formation of a fjord?',
    'Which desert is the largest in the world?',
    'Why does the Amazon rainforest produce so much oxygen?',
    'What is the difference between weather and climate?',
    'How do coral reefs form over time?',
    'Why do some rivers change course over centuries?',

    // Music
    'What distinguishes a symphony from a concerto?',
    'How does a pipe organ produce different pitches?',
    'What is the origin of the twelve-bar blues progression?',
    'Why do orchestras tune to the note A before a performance?',
    'What makes a violin sound different from a viola?',
    'How did jazz improvisation develop in the early twentieth century?',
    'What is the difference between a major and minor scale?',
    'Why do some singers use vibrato while others do not?',

    // Sports
    'What are the basic rules of scoring in cricket?',
    'How is a marathon distance officially standardized?',
    'What is the offside rule in soccer?',
    'Why do sprinters use starting blocks in track events?',
    'How does a tiebreaker work in tennis?',
    'What equipment is required for competitive fencing?',
    'Why do cyclists draft behind each other in races?',
    'How are weight classes determined in boxing?',

    // Weather and climate
    'What causes a hurricane to form over warm ocean water?',
    'Why does humidity make hot weather feel more uncomfortable?',
    'What is the difference between sleet and freezing rain?',
    'How do meteorologists predict the path of a storm?',
    'Why do deserts get so cold at night?',
    'What causes lightning during a thunderstorm?',
    'How does the jet stream affect regional weather patterns?',
    'Why does dew form on grass in the early morning?',

    // Wildlife and animals
    'How do migratory birds navigate over long distances?',
    'Why do some animals hibernate through the winter?',
    'What is the diet of a typical gray wolf pack?',
    'How do octopuses change color to camouflage themselves?',
    'Why do elephants have such large ears?',
    'What is the lifespan of a giant tortoise?',
    'How do bees communicate the location of flowers to the hive?',
    'Why do some fish travel in schools?',

    // Nutrition and health
    'What vitamins are essential for maintaining healthy vision?',
    'How much water should an average adult drink each day?',
    'What is the difference between soluble and insoluble fiber?',
    'Why is vitamin D important for bone health?',
    'How does regular aerobic exercise affect resting heart rate?',
    'What causes muscle soreness after intense exercise?',
    'Why is sleep important for memory consolidation?',
    'What are the health benefits of a Mediterranean diet?',

    // Art and painting
    'What distinguishes impressionist painting from realism?',
    'How did the invention of oil paint change European art?',
    'What is the difference between fresco and tempera painting?',
    'Why did Renaissance artists study human anatomy so closely?',
    'What techniques did pointillist painters use to blend color?',
    'How does chiaroscuro create depth in a painting?',
    'What materials are used in traditional watercolor painting?',
    'Why is perspective drawing important in realistic art?',

    // Literature
    'What defines a novel as belonging to the gothic genre?',
    'How did the epic poem evolve in ancient Greek literature?',
    'What is the difference between a metaphor and a simile?',
    'Why is unreliable narration used in some novels?',
    'What characterizes the literary style of magical realism?',
    'How does a sonnet differ structurally from a haiku?',
    'What role does foreshadowing play in a mystery novel?',
    'Why did serialized fiction become popular in the 19th century?',

    // Automobiles and mechanics
    'How does a combustion engine convert fuel into motion?',
    'What is the purpose of a car\'s catalytic converter?',
    'Why do tires need to be rotated periodically?',
    'How does regenerative braking work in a hybrid vehicle?',
    'What causes a car battery to lose its charge over time?',
    'Why is wheel alignment important for tire wear?',
    'How does an automatic transmission decide when to shift gears?',
    'What is the function of a car\'s suspension system?',

    // Geology
    'How do tectonic plates cause earthquakes?',
    'What is the difference between igneous and sedimentary rock?',
    'How do stalactites form inside limestone caves?',
    'Why do volcanoes tend to form along plate boundaries?',
    'What causes the layered appearance of the Grand Canyon?',
    'How do geologists estimate the age of rock formations?',
    'Why is obsidian formed from rapidly cooling lava?',
    'What causes a geyser to erupt periodically?',

    // Textiles and crafts
    'What is the difference between knitting and crocheting?',
    'How is silk fiber harvested from silkworm cocoons?',
    'Why does wool felt when washed in hot water?',
    'What dyes were traditionally used to color wool before synthetic dyes?',
    'How does a spinning wheel turn raw fiber into yarn?',
    'What is the difference between warp and weft in weaving?',
    'Why is linen fabric popular in warm climates?',
    'How do quilters piece together a traditional patchwork pattern?',

    // Travel and transportation
    'Why do commercial airplanes cruise at high altitude?',
    'How does a compass needle align with magnetic north?',
    'What causes jet lag when crossing multiple time zones?',
    'Why do cruise ships use stabilizers in rough seas?',
    'How do lighthouses historically warn ships of rocky coastlines?',
    'What is the purpose of a passport visa when traveling abroad?',
    'Why do trains use different rail gauges in different countries?',
    'How does a hot air balloon control its altitude?',
] as const;
