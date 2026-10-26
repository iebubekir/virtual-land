import{i as e}from"./rolldown-runtime-COiEfhsA.js";import"./modulepreload-polyfill-P2Xu9kJm.js";import{t}from"./leaflet-src-BXdv2rsm.js";import{i as n,r,s as i,u as a}from"./common-BaMgQ_JQ.js";var o=e(t(),1);n();var s=e=>String(e).replace(/[&<>"']/g,e=>({"&":`&amp;`,"<":`&lt;`,">":`&gt;`,'"':`&quot;`,"'":`&#39;`})[e]);document.getElementById(`packages`).innerHTML=i.map(e=>`
  <article class="pkg${e.highlighted?` featured`:``}">
    <div class="pkg-top">
      <h3>${s(e.name)}</h3>
      ${e.highlighted?`<span class="pkg-badge">En çok tercih edilen</span>`:``}
    </div>
    <p class="pkg-summary">${s(e.summary)}</p>
    <p class="pkg-price">${s(a(e.price))}<small>/ video</small></p>
    ${e.oldPrice?`<p class="pkg-old">${s(a(e.oldPrice))}</p>`:``}
    <ul>${e.features.map(e=>`<li>${s(e)}</li>`).join(``)}</ul>
    <a class="btn ${e.highlighted?`btn-ghost`:`btn-dark`}" href="siparis/?paket=${encodeURIComponent(e.id)}">${s(e.name)} sipariş et</a>
  </article>`).join(``);var c=[[40.37182,28.884705],[40.371784,28.88533],[40.372198,28.885365],[40.37227,28.884941],[40.372108,28.884682]],l=document.querySelector(`.phone`),u=o.default.map(`heroMap`,{zoomControl:!1,attributionControl:!1,dragging:!1,scrollWheelZoom:!1,doubleClickZoom:!1,boxZoom:!1,keyboard:!1,touchZoom:!1,zoomSnap:0});o.default.tileLayer(r,{maxNativeZoom:17,maxZoom:20,crossOrigin:!0}).addTo(u);var d=o.default.polygon(c,{color:`#f4c430`,weight:3,fillColor:`#f4c430`,className:`hero-parcel`}).addTo(u);u.fitBounds(d.getBounds(),{padding:[70,70]}),u.setZoom(Math.min(u.getZoom(),18.2)),d.getElement()?.setAttribute(`pathLength`,`1000`);var f=!1,p=()=>{f||(f=!0,l.classList.add(`ready`))};u.once(`load`,p),u.eachLayer(e=>e.once?.(`load`,p)),setTimeout(p,1600);