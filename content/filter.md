---
title: "📂 REITs 文件筛选"
layout: "page"
---

<div id="filter-app" style="max-width: 1200px; margin: 0 auto; padding: 20px;">
  <h1>📂 REITs 文件筛选</h1>
  <p style="color: #666; margin-bottom: 20px;">选择以下维度筛选文件：</p>

  <!-- 筛选栏 -->
  <div style="display: flex; flex-wrap: wrap; gap: 15px; background: #f5f5f5; padding: 20px; border-radius: 8px; margin-bottom: 25px; align-items: flex-end;">
    <div>
      <label style="display: block; font-weight: 600; font-size: 14px; margin-bottom: 4px;">领域</label>
      <select id="filter-area" style="padding: 8px 12px; border-radius: 4px; border: 1px solid #ccc; min-width: 140px;">
        <option value="">全部</option>
      </select>
    </div>
    <div>
      <label style="display: block; font-weight: 600; font-size: 14px; margin-bottom: 4px;">业态</label>
      <select id="filter-sector" style="padding: 8px 12px; border-radius: 4px; border: 1px solid #ccc; min-width: 140px;">
        <option value="">全部</option>
      </select>
    </div>
    <div>
      <label style="display: block; font-weight: 600; font-size: 14px; margin-bottom: 4px;">交易所</label>
      <select id="filter-exchange" style="padding: 8px 12px; border-radius: 4px; border: 1px solid #ccc; min-width: 140px;">
        <option value="">全部</option>
      </select>
    </div>
    <div>
      <label style="display: block; font-weight: 600; font-size: 14px; margin-bottom: 4px;">年份</label>
      <select id="filter-year" style="padding: 8px 12px; border-radius: 4px; border: 1px solid #ccc; min-width: 140px;">
        <option value="">全部</option>
      </select>
    </div>
    <button onclick="resetFilters()" style="padding: 8px 24px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer; height: 38px;">重置</button>
  </div>

  <!-- 统计和结果 -->
  <div id="result-stats" style="margin-bottom: 15px; font-size: 14px; color: #666;"></div>
  <div id="result-list" style="display: grid; gap: 8px;"></div>
</div>

<script>
  // ============================================
  // 从 Quartz 的 index.json 读取所有文件信息
  // ============================================
  let allFiles = [];

  document.addEventListener('DOMContentLoaded', function() {
    // 加载 Quartz 生成的 index.json
    fetch('/content/contentIndex.json')
      .then(response => {
        if (!response.ok) throw new Error('无法加载 index.json');
        return response.json();
      })
      .then(data => {
        // 提取文件列表
        const files = data.files || [];
        console.log('找到文件数量:', files.length);

        // 筛选出 .md 文件
        const mdFiles = files.filter(f => f.endsWith('.md'));
        
        // 构建文件信息列表，从 frontmatter 中提取元数据
        allFiles = mdFiles.map(filename => {
          const name = filename.replace(/\.md$/, '');
          // 从 index.json 中获取 frontmatter
          const fileData = data.fileMap ? data.fileMap[filename] : null;
          const frontmatter = fileData?.frontmatter || {};
          
          return {
            name: name,
            title: frontmatter.title || name,
            area: frontmatter.area || '',
            sector: frontmatter.sector || '',
            exchange: frontmatter.exchange || '',
            year: frontmatter.year || ''
          };
        });

        if (allFiles.length === 0) {
          document.getElementById('result-list').innerHTML = '<p style="color: #999;">没有找到任何 Markdown 文件。</p>';
          return;
        }

        // 填充下拉菜单
        populateSelect('filter-area', getUniqueValues('area'));
        populateSelect('filter-sector', getUniqueValues('sector'));
        populateSelect('filter-exchange', getUniqueValues('exchange'));
        populateSelect('filter-year', getUniqueValues('year'));

        // 绑定筛选事件
        document.querySelectorAll('#filter-app select').forEach(select => {
          select.addEventListener('change', applyFilters);
        });

        // 初始渲染
        applyFilters();
      })
      .catch(error => {
        console.error('加载数据失败:', error);
        document.getElementById('result-list').innerHTML = `
          <p style="color: #d32f2f;">加载数据失败: ${error.message}</p>
          <p style="color: #666; font-size: 14px;">请确保 Quartz 配置中启用了 index.json（enableIndexJson: true）</p>
        `;
      });
  });

  // ============================================
  // 辅助函数
  // ============================================
  function getUniqueValues(key) {
    const values = new Set();
    for (const file of allFiles) {
      if (file[key]) values.add(file[key]);
    }
    return Array.from(values).sort();
  }

  function populateSelect(id, options) {
    const select = document.getElementById(id);
    if (!select) return;
    const defaultOption = select.querySelector('option[value=""]');
    select.innerHTML = '';
    if (defaultOption) select.appendChild(defaultOption);
    options.forEach(opt => {
      const option = document.createElement('option');
      option.value = opt;
      option.textContent = opt;
      select.appendChild(option);
    });
  }

  function resetFilters() {
    document.querySelectorAll('#filter-app select').forEach(select => {
      select.value = '';
    });
    applyFilters();
  }

  function applyFilters() {
    const area = document.getElementById('filter-area').value;
    const sector = document.getElementById('filter-sector').value;
    const exchange = document.getElementById('filter-exchange').value;
    const year = document.getElementById('filter-year').value;

    const results = allFiles.filter(file => {
      let match = true;
      if (area && file.area !== area) match = false;
      if (sector && file.sector !== sector) match = false;
      if (exchange && file.exchange !== exchange) match = false;
      if (year && file.year !== year) match = false;
      return match;
    });

    // 更新统计
    const stats = document.getElementById('result-stats');
    stats.textContent = `找到 ${results.length} 个文件（共 ${allFiles.length} 个）`;

    // 更新列表
    const list = document.getElementById('result-list');
    if (results.length === 0) {
      list.innerHTML = '<p style="color: #999;">没有匹配的文件</p>';
      return;
    }

    results.sort((a, b) => a.name.localeCompare(b.name));

    list.innerHTML = results.map(file => {
      const tags = [file.area, file.sector, file.exchange, file.year].filter(Boolean);
      return `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; background: white; border: 1px solid #eee; border-radius: 6px;">
          <a href="/${encodeURIComponent(file.name)}" style="color: #1a73e8; text-decoration: none; font-weight: 500;">
            ${file.title}
          </a>
          <span style="font-size: 12px; color: #888;">
            ${tags.join(' · ')}
          </span>
        </div>
      `;
    }).join('');
  }
</script>

<style>
  #filter-app select:focus {
    outline: none;
    border-color: #1a73e8;
    box-shadow: 0 0 0 2px rgba(26,115,232,0.2);
  }
  #filter-app button:hover {
    opacity: 0.85;
  }
</style>
