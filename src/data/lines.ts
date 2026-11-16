import { currentFestival } from '../core/festival';
import { currentSeason } from '../core/season';
import { isNightNow } from '../core/daynight';

/**
 * 居民的日常用语。
 * 写得克制一点：不夸夸其谈、不推动剧情，就是小镇里擦肩而过的一句话。
 * 目的是让挂机时的画面多一点生活气，而不是塞信息给玩家。
 */
export const SPEECH_LINES: string[] = [
  '今天天气真好啊',
  '慢慢来，比较快',
  '要不要来杯咖啡',
  '那朵云像棉花糖',
  '刚出炉的面包最香了',
  '我小时候就在这儿玩',
  '风里有青草的味道',
  '今天也要好好生活呀',
  '你看那边的夕阳',
  '不着急，日子还长',
  '散步是最好的休息',
  '听说果园的花开了',
  '谢谢你把小镇打理得这么好',
  '我每天都走这条小路',
  '累了就抬头看看云吧',
  '明天想种点什么呢',
  '这条路的树荫最凉快',
  '面包坊的香味飘过来了',
  '最近睡得特别好',
  '小镇又变热闹了',
  '慢慢走，风景都在路上',
  '今天的风很温柔',
  '我数过，岛上一共有十七棵树',
  '傍晚的喷泉最好看',
  '要不要一起去看云',
];

/** 季节专属的日常话：换个季节，居民嘴里的话也跟着变 */
export const SEASON_LINES: Record<string, string[]> = {
  spring: ['花开得真好', '风里有花香', '燕子回来了', '该给花园松松土了'],
  summer: ['蝉一直在叫', '午后有点晒', '河边最凉快', '要不要来个西瓜'],
  autumn: ['风变凉了', '叶子开始黄了', '今年的南瓜不错', '该收点东西过冬了'],
  winter: ['手有点凉', '呼出来的气都是白的', '外面风大，进屋坐坐', '今年会不会下雪'],
};

/** 节日期间的应景话 */
export const FESTIVAL_LINES: Record<string, string[]> = {
  sakura: ['樱花祭的花真好看', '落了一身花瓣', '要不要去树下坐坐'],
  nightmarket: ['夜市好热闹', '来串烤年糕吗', '今晚灯特别亮'],
  harvest: ['丰收节快乐', '今年收成真好', '来尝一口新做的'],
  snowlight: ['雪灯今晚点亮了', '许个愿吧', '灯笼照得雪地发亮'],
};

/** 夜里的话 */
export const NIGHT_LINES: string[] = ['该回家睡觉啦', '月亮真亮', '最后再看一眼就回去', '晚安，小镇'];

/** 按「节日 > 季节 > 夜晚 > 日常」的权重混一句 */
export function randomLine(): string {
  const fest = currentFestival();
  const season = currentSeason();
  const night = isNightNow();
  const pool: string[] = [...SPEECH_LINES];
  const seasonLines = SEASON_LINES[season.id] ?? [];
  if (seasonLines.length) pool.push(...seasonLines, ...seasonLines); // 季节话出现率翻倍
  if (night) pool.push(...NIGHT_LINES, ...NIGHT_LINES);
  const festLines = fest ? FESTIVAL_LINES[fest.id] ?? [] : [];
  if (festLines.length) pool.push(...festLines, ...festLines, ...festLines); // 节日话最优先
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * 专职农民的台词。都是跟种地、打理有关的大白话，
 * 只有近距离点他才会冒出来，不主动凑热闹。
 */
export const FARM_LINES: string[] = [
  '这块地的苗长得不错',
  '今天得给番茄浇浇水',
  '草又冒出来了，得拔一拔',
  '土松一松，根才舒服',
  '今年的收成应该不赖',
  '慢工出细活，庄稼急不得',
  '这片叶子有点卷，得多顾着点',
  '刚翻完土，累是累点但踏实',
  '虫子少，是个好兆头',
  '等熟了，第一茬先给你尝尝',
  '风调雨顺，庄稼人最开心',
  '垄要排整齐，看着就舒心',
  '早上露水重，下地要趁早',
  '歇会儿，听听蝉叫也挺好',
];

export function randomFarmLine(): string {
  return FARM_LINES[Math.floor(Math.random() * FARM_LINES.length)];
}

/**
 * 伐木工的台词。守在树林里、围着木头堆和锯子转，说的是伐木、备料的大白话。
 * 像农民一样始终在林子里，近距离点他才冒出来。
 */
export const LUMBER_LINES: string[] = [
  '这棵原木的纹路真漂亮',
  '锯子得常上油，才顺手',
  '今天多备点木料，盖房不愁',
  '木头堆得整整齐齐才踏实',
  '听，斧头落下的声音最解压',
  '阴干的料比新砍的更耐用',
  '歇口气，喝口水再干',
  '这截够做一张小桌了',
  '林场里最不缺的就是耐心',
  '树皮的香气，闻着就安心',
  '一堆柴火，够烧整个冬天',
  '慢点锯，线才直',
];

export function randomLumberLine(): string {
  return LUMBER_LINES[Math.floor(Math.random() * LUMBER_LINES.length)];
}

/**
 * 畜牧场工人的台词。围着栅栏和干草转，说的是喂牲口、挤奶的大白话。
 * 只有建了畜牧场、近距离点他才冒出来。
 */
export const RANCH_LINES: string[] = [
  '小牛今天胃口不错',
  '草料得新鲜，它们才肯吃',
  '挤奶要轻，别惊着它',
  '栅栏有点松，待会儿加固一下',
  '傍晚的干草堆最暖和',
  '这群小家伙比孩子还黏人',
  '牛奶够新鲜，你尝尝',
  '得把水槽的水换干净',
  '牲口安生，牧场就安生',
  '赶它们回圈，天快黑了',
  '这几只最挑食，得单独喂',
  '听着此起彼伏的叫声，也挺热闹',
];

export function randomRanchLine(): string {
  return RANCH_LINES[Math.floor(Math.random() * RANCH_LINES.length)];
}
