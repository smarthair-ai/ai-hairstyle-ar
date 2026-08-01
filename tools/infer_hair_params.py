#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
为 public/models/hair/hairDatabase.json 里以 "h" 开头的 Excel 发型，
根据名称 / 特点 / 分类推断 3D 程序化建模参数(params)，使其无需下载任何
模型即可在 AR 里试戴。只覆盖 params 字段，保留图片、脸型、难度等其它数据。

用法： python tools/infer_hair_params.py
"""
import json
import re

PATH = 'public/models/hair/hairDatabase.json'


def infer_params(m):
    name = m.get('name') or ''
    feats = m.get('features') or []
    cat = (m.get('categories') or ([m.get('category')] if m.get('category') else [])) or ['medium']
    cat = cat[0]
    text = name + ' ' + ' '.join(feats)

    # 按长度给一套基础参数
    if cat == 'long':
        p = dict(volume=1.10, frontPhi=0.95, sidePhi=1.52, backPhi=1.90,
                 frontLen=0.12, sideLen=1.45, backLen=1.62,
                 wave=0.05, waveFreq=4, curl=0.006, part=0, taper=0.55)
    elif cat == 'short':
        p = dict(volume=1.08, frontPhi=0.95, sidePhi=1.42, backPhi=1.80,
                 frontLen=0.10, sideLen=0.12, backLen=0.12,
                 wave=0.03, waveFreq=3, curl=0.006, part=0, taper=0.5)
    else:  # medium
        p = dict(volume=1.10, frontPhi=0.97, sidePhi=1.50, backPhi=1.86,
                 frontLen=0.12, sideLen=0.55, backLen=0.62,
                 wave=0.04, waveFreq=2.5, curl=0.005, part=0, taper=0.65)

    # 刘海 / 分缝
    if re.search(r'齐刘海|厚齐|厚款齐眉|法式齐刘海|厚齐刘海|齐眉', text):
        p['frontLen'] = 0.26
    elif re.search(r'八字|侧分|三七|斜刘海', text):
        p['frontLen'] = 0.18
        p['part'] = 1
    elif re.search(r'中分', text):
        p['part'] = 0
    elif re.search(r'露额|露额头|上庭', text):
        p['frontLen'] = 0.04
    elif re.search(r'刘海|漫画刘海|空气刘海|轻薄刘海|薄刘海', text):
        p['frontLen'] = 0.20

    # 卷度
    if re.search(r'羊毛卷|细密小卷|小卷|爆炸|蓬松饱满|卷形', text):
        p['curl'] = 0.05
        p['wave'] = 0.06
        p['volume'] = max(p['volume'], 1.28)
    elif re.search(r'大波浪|水波纹|波浪|气垫烫|蛋卷|纹理烫|烫|卷', text):
        big = ('大波浪' in text) or ('水波纹' in text)
        p['wave'] = 0.12 if big else 0.09
        p['waveFreq'] = 5 if big else 4
        p['curl'] = max(p['curl'], 0.012)
    if re.search(r'直|一刀切|顺滑|黑长直|直款|齐整|利落', text):
        p['wave'] = 0.02
        p['curl'] = 0.003
        p['taper'] = 0.78
        p['volume'] = min(p['volume'], 1.07)

    # 蓬松 / 发量
    if re.search(r'蓬松|高颅顶|发根蓬松|垫高颅顶|增加发量|发量|立体感|饱满|层次', text):
        p['volume'] = min(1.34, p['volume'] + 0.12)

    # 内扣
    if re.search(r'内收|内扣|发尾内扣|发尾内收', text):
        p['taper'] = 0.8

    # 狼尾 / 鲻鱼：后段加长 + 层次
    if re.search(r'狼尾|鲻鱼|长短落差', text):
        p['backLen'] = max(p['backLen'], 0.9 if cat == 'short' else 1.3)
        p['layers'] = [{'lenScale': 0.4, 'volume': 1.08}]

    # 寸头 / 前刺 / 飞机头 / 背头：极短（"渐变"仅在与短发词同现时才算推剪渐变，
    # 避免把"渐变挑染""拳击辫脏辫"误判成光头）
    is_buzz = re.search(r'寸头|前刺|飞机头|背头|碎刺|刺头|推剪|摩根烫', text)
    if not is_buzz and re.search(r'渐变', text) and re.search(r'短|推|寸|男', text):
        is_buzz = True
    if is_buzz and not re.search(r'辫|编|麻花', text):
        p.update(volume=1.04, frontLen=0.04, sideLen=0.02, backLen=0.03,
                 wave=0.02, curl=0.004, taper=0.4, part=0)

    # 波波 / 蘑菇
    if re.search(r'波波|蘑菇', text):
        p.update(sideLen=0.60, backLen=0.66, taper=0.75)
        if re.search(r'齐刘海|厚齐', text):
            p['frontLen'] = 0.26

    # 公主切 / 姬发
    if re.search(r'公主切|姬发', text):
        p.update(frontLen=0.26, taper=0.82, volume=1.05)
        p['layers'] = [{'lenScale': 0.6, 'volume': 1.02}]

    # 水母头
    if re.search(r'水母头', text):
        p['layers'] = [{'lenScale': 0.6, 'volume': 1.04}]

    # 编发 / 脏辫 → 程序化麻花辫部件
    if re.search(r'麻花辫|辫|编|拳击辫|脏辫', text):
        p['extra'] = 'braids'
    elif re.search(r'双马尾|双辫', text):
        p['extra'] = 'twintail'
    elif re.search(r'丸子|发髻|团子', text):
        p['extra'] = 'topknot'
    elif re.search(r'马尾', text):
        p['extra'] = 'ponytail'

    return p


def main():
    d = json.load(open(PATH, encoding='utf-8'))
    models = d['models']
    n = 0
    for m in models:
        if str(m.get('id', '')).startswith('h'):
            m['params'] = infer_params(m)
            n += 1
    json.dump(d, open(PATH, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    open(PATH, 'a').write('\n')
    print('已为 %d 款 Excel 发型推断并写入 params' % n)


if __name__ == '__main__':
    main()
